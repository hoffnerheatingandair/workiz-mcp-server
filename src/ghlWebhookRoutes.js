// Handles inbound GHL "appointment booked" webhooks and creates a matching
// Workiz job. This webhook is fired by a GHL Workflow's "Webhook" action
// (triggered on the "Appointment Status" / booking trigger), not GHL's raw
// system webhooks -- so the JSON body shape is whatever you configure in
// that action. Configure it to send:
//
//   {
//     "contact": {
//       "id": "{{contact.id}}",
//       "firstName": "{{contact.first_name}}",
//       "lastName": "{{contact.last_name}}",
//       "phone": "{{contact.phone}}",
//       "email": "{{contact.email}}",
//       "address1": "{{contact.address1}}",
//       "unit": "{{contact.address2}}",
//       "city": "{{contact.city}}",
//       "state": "{{contact.state}}",
//       "postalCode": "{{contact.postal_code}}",
//       "country": "{{contact.country}}"
//     },
//     "appointment": {
//       "title": "{{appointment.title}}",
//       "startTime": "{{appointment.start_time}}",
//       "endTime": "{{appointment.end_time}}",
//       "notes": "{{appointment.notes}}"
//     }
//   }
//
// and add a custom header: Authorization: Bearer <GHL_WEBHOOK_SECRET>
import { Router } from "express";
import * as workiz from "./workizClient.js";
import * as ghl from "./ghlClient.js";
import { toE164, fromE164ToWorkizPhone } from "./phone.js";
import { toWorkizDateRange, fromWorkizDateTime } from "./datetime.js";
import { getBlocksForJob, setBlocksForJob, deleteBlocksForJob } from "./ghlBlockStore.js";
import { WORKIZ_TO_GHL_USER } from "./techMap.js";

function ok(res, data) {
  return res.status(200).json({ ok: true, ...data });
}
function fail(res, status, err) {
  // Full stack for real server errors; a one-liner for expected 4xx (auth
  // failures / bad payloads) so bot traffic doesn't flood the logs.
  if (status >= 500) {
    console.error("[ghlWebhook]", err);
  } else {
    console.warn("[ghlWebhook]", err?.message || String(err));
  }
  return res.status(status).json({ ok: false, error: err?.message || String(err) });
}

// Builds a bearer-auth middleware for the given env var. Fails closed if the
// secret isn't configured -- unlike MCP_SERVER_KEY, these are public webhook
// receivers, so an unset secret should not mean "open".
function checkBearerAuth(envVar) {
  return (req, res, next) => {
    const secret = process.env[envVar];
    if (!secret) {
      return fail(res, 500, new Error(`${envVar} is not configured on the server`));
    }
    const header = req.headers["authorization"] || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : header;
    if (token !== secret) {
      return fail(res, 401, new Error("Unauthorized"));
    }
    next();
  };
}

// Accepts the nested contact/appointment shape documented above, and falls
// back to flat top-level keys in case the workflow's webhook action is
// configured without the grouping.
function extractBooking(body = {}) {
  const contact = body.contact || body;
  const appointment = body.appointment || body;

  return {
    contactId: contact.id || contact.contactId || body.contact_id,
    firstName: contact.firstName || contact.first_name,
    lastName: contact.lastName || contact.last_name,
    phone: contact.phone,
    email: contact.email,
    address1: contact.address1 || contact.address,
    unit: contact.unit || contact.address2,
    city: contact.city,
    state: contact.state,
    postalCode: contact.postalCode || contact.postal_code,
    country: contact.country,
    title: appointment.title,
    startTime: appointment.startTime || appointment.start_time,
    endTime: appointment.endTime || appointment.end_time,
    durationMinutes: appointment.durationMinutes || appointment.duration_minutes,
    notes: appointment.notes,
    jobType: body.jobType,
    team: body.team,
  };
}

const router = Router();

router.post("/webhooks/ghl/booking", checkBearerAuth("GHL_WEBHOOK_SECRET"), async (req, res) => {
  try {
    const booking = extractBooking(req.body);

    if (!booking.phone) {
      return fail(res, 400, new Error("Webhook payload is missing a contact phone number"));
    }

    // E.164 is only the match key (for reconciling against GHL/future
    // Workiz->GHL sync) -- Workiz's own Phone field wants plain digits.
    const phoneE164 = toE164(booking.phone);
    const workizPhone = fromE164ToWorkizPhone(phoneE164);

    const { start, end } = toWorkizDateRange(booking.startTime, {
      isoEnd: booking.endTime,
      durationMinutes: booking.durationMinutes,
    });

    // Field names/shape confirmed against a real job/get/ record -- see the
    // comment above createJob in workizClient.js.
    const jobFields = {
      FirstName: booking.firstName,
      LastName: booking.lastName,
      Phone: workizPhone,
      Email: booking.email,
      Address: booking.address1,
      Unit: booking.unit,
      City: booking.city,
      State: booking.state,
      PostalCode: booking.postalCode,
      Country: booking.country || "US",
      JobDateTime: start,
      JobEndDateTime: end,
      JobType: booking.jobType || "Service Call",
      JobSource: "GHL Online Booking",
      JobName: booking.title,
      JobNotes: booking.notes,
      // Team assignment needs a GHL calendarId -> Workiz tech mapping we
      // don't have yet; pass `team: [{ id, Name }]` in the webhook body to
      // set it explicitly, otherwise Workiz leaves the job unassigned.
      Team: booking.team,
    };

    // Drop empty fields so we don't send blanks over real Workiz defaults.
    for (const [key, value] of Object.entries(jobFields)) {
      const isEmpty =
        value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
      if (isEmpty) delete jobFields[key];
    }

    const result = await workiz.createJob(jobFields);
    return ok(res, { workiz: result, matchedPhone: phoneE164 });
  } catch (err) {
    return fail(res, 500, err);
  }
});

// ---------------------------------------------------------------------
// Workiz -> GHL: block/free a tech's GHL availability when their Workiz
// jobs are created, rescheduled, or canceled, so they can't be
// double-booked online. Configure a Workiz webhook (job created/updated)
// to POST here with `Authorization: Bearer <WORKIZ_WEBHOOK_SECRET>`.
// ---------------------------------------------------------------------

const CANCELED_STATUSES = new Set(["canceled", "cancelled", "deleted"]);

function extractWorkizJob(body = {}) {
  return {
    uuid: body.UUID || body.uuid,
    startWorkiz: body.JobDateTime,
    endWorkiz: body.JobEndDateTime,
    status: body.Status || body.status,
    team: Array.isArray(body.Team) ? body.Team : [],
  };
}

// GHL 404s (event already gone -- e.g. deleted manually in GHL) shouldn't
// block a cancel/reschedule; anything else should surface as a real error.
async function deleteBlockIgnoring404(eventId) {
  try {
    await ghl.deleteCalendarEvent(eventId);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
}

router.post("/webhooks/workiz/job", checkBearerAuth("WORKIZ_WEBHOOK_SECRET"), async (req, res) => {
  try {
    const job = extractWorkizJob(req.body);

    if (!job.uuid) {
      return fail(res, 400, new Error("Webhook payload is missing a job UUID"));
    }

    const existingBlocks = await getBlocksForJob(job.uuid);
    const isCanceled = job.status && CANCELED_STATUSES.has(String(job.status).toLowerCase());

    if (isCanceled) {
      for (const eventId of Object.values(existingBlocks)) {
        await deleteBlockIgnoring404(eventId);
      }
      await deleteBlocksForJob(job.uuid);
      return ok(res, { uuid: job.uuid, canceled: true, removedBlocks: Object.keys(existingBlocks).length });
    }

    if (!job.startWorkiz || !job.endWorkiz) {
      return fail(res, 400, new Error("Webhook payload is missing JobDateTime/JobEndDateTime"));
    }

    const startTime = fromWorkizDateTime(job.startWorkiz);
    const endTime = fromWorkizDateTime(job.endWorkiz);
    const title = `Workiz Job ${job.uuid}`;

    const mappedTeam = job.team
      .map((member) => ({ workizId: String(member.id), ghlUserId: WORKIZ_TO_GHL_USER[String(member.id)] }))
      .filter((m) => m.ghlUserId);

    const unmapped = job.team.filter((member) => !WORKIZ_TO_GHL_USER[String(member.id)]);
    if (unmapped.length) {
      console.warn(
        "[workizWebhook] No GHL user mapping for Workiz tech(s):",
        unmapped.map((m) => `${m.Name || "?"} (${m.id})`).join(", ")
      );
    }

    const updatedBlocks = {};

    // Create or reschedule a block for each currently-assigned, mapped tech.
    for (const { ghlUserId } of mappedTeam) {
      const existingEventId = existingBlocks[ghlUserId];
      if (existingEventId) {
        await ghl.updateBlockSlot(existingEventId, { assignedUserId: ghlUserId, startTime, endTime, title });
        updatedBlocks[ghlUserId] = existingEventId;
      } else {
        const created = await ghl.blockSlot({ assignedUserId: ghlUserId, startTime, endTime, title });
        updatedBlocks[ghlUserId] = created.id;
      }
    }

    // Remove blocks for techs that were unassigned in this reschedule.
    for (const [ghlUserId, eventId] of Object.entries(existingBlocks)) {
      if (!updatedBlocks[ghlUserId]) {
        await deleteBlockIgnoring404(eventId);
      }
    }

    await setBlocksForJob(job.uuid, updatedBlocks);
    return ok(res, { uuid: job.uuid, blocks: updatedBlocks });
  } catch (err) {
    return fail(res, 500, err);
  }
});

export default router;
