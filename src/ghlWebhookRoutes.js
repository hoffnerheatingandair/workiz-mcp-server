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
import { WORKIZ_TO_GHL_USER, WORKIZ_NAME_TO_GHL_USER } from "./techMap.js";

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

// Confirmed real webhook shape (captured from a live Workiz job_created
// event -- this does NOT match the job/get/ REST API's field names):
//   {
//     "trigger": { "type": "job_created", "timestamp": "..." },
//     "data": {
//       "uuid", "status", "date" ("YYYY-MM-DD HH:MM:SS"), "endDate" (same format),
//       "team": [{ "id": "USR-...", "name": "..." }, ...], ...more
//     },
//     "metadata": { "automationId", "ruleName" }
//   }
// NOTE: data.team[].id is a Workiz "USR-..." string id, NOT the numeric
// Workiz id (e.g. 443756) used elsewhere (job Team API, techMap.js keys
// pre-dating this). techMap.js must be keyed on the USR- id for matches to
// work at all.
function extractWorkizJob(body = {}) {
  const data = body.data || {};
  return {
    uuid: data.uuid,
    status: data.status,
    triggerType: body.trigger?.type,
    startWorkiz: data.date,
    endWorkiz: data.endDate,
    team: Array.isArray(data.team) ? data.team : [],
  };
}

// trigger.type values confirmed so far: "job_created". Cancel/delete types
// are assumed to follow the same "job_<verb>" pattern (per Workiz's own
// naming) -- confirm against real fired events and extend this set as
// needed once we've seen a cancellation come through.
const CANCEL_TRIGGER_TYPES = new Set(["job_canceled", "job_cancelled", "job_deleted"]);

// GHL 404s (event already gone -- e.g. deleted manually in GHL) shouldn't
// block a cancel/reschedule; anything else should surface as a real error.
async function deleteBlockIgnoring404(eventId) {
  try {
    await ghl.deleteCalendarEvent(eventId);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
}

// TEMP: logs the complete raw request body before auth is even checked, so
// every hit -- authenticated or not -- prints exactly what was sent. Remove
// once extractWorkizJob's field names below are confirmed against a real
// payload.
function logRawBody(req, res, next) {
  console.log("RAW WORKIZ BODY:", JSON.stringify(req.body));
  next();
}

router.post("/webhooks/workiz/job", logRawBody, checkBearerAuth("WORKIZ_WEBHOOK_SECRET"), async (req, res) => {
  try {
    // TEMP: log the full raw payload broken into pieces so we can see
    // Workiz's actual field names for schedule start/end and tech
    // assignment inside `data`. Remove/gate behind a DEBUG env var once
    // extractWorkizJob is filled in with confirmed field names.
    console.log("[workizWebhook] RAW trigger:", JSON.stringify(req.body?.trigger));
    console.log("[workizWebhook] RAW data:", JSON.stringify(req.body?.data, null, 2));
    console.log("[workizWebhook] RAW data.team:", JSON.stringify(req.body?.data?.team));

    const job = extractWorkizJob(req.body);
    console.log(
      `[workizWebhook] uuid=${job.uuid} status=${job.status} triggerType=${job.triggerType}`
    );

    if (!job.uuid) {
      return fail(res, 400, new Error("Webhook payload is missing a job UUID (data.uuid)"));
    }

    const existingBlocks = await getBlocksForJob(job.uuid);
    const isCanceled = CANCEL_TRIGGER_TYPES.has(String(job.triggerType || "").toLowerCase());

    if (isCanceled) {
      for (const eventId of Object.values(existingBlocks)) {
        await deleteBlockIgnoring404(eventId);
      }
      await deleteBlocksForJob(job.uuid);
      return ok(res, { uuid: job.uuid, canceled: true, removedBlocks: Object.keys(existingBlocks).length });
    }

    if (!job.startWorkiz || !job.endWorkiz) {
      return fail(res, 400, new Error("Webhook payload is missing data.date/data.endDate"));
    }

    const startTime = fromWorkizDateTime(job.startWorkiz);
    const endTime = fromWorkizDateTime(job.endWorkiz);
    const title = `Workiz Job ${job.uuid}`;

    // Match by Workiz "USR-..." id first; fall back to name if the id
    // doesn't match (e.g. Workiz re-issues a user id) -- logged either way
    // so a name-fallback match or a true miss are both visible, not silent.
    function resolveGhlUserId(member) {
      const byId = WORKIZ_TO_GHL_USER[String(member.id)];
      if (byId) return { ghlUserId: byId, matchedBy: "id" };
      const byName = member.name ? WORKIZ_NAME_TO_GHL_USER[String(member.name).trim().toLowerCase()] : null;
      if (byName) return { ghlUserId: byName, matchedBy: "name" };
      return { ghlUserId: null, matchedBy: null };
    }

    const resolvedTeam = job.team.map((member) => ({ member, ...resolveGhlUserId(member) }));
    const mappedTeam = resolvedTeam.filter((r) => r.ghlUserId);
    const unmapped = resolvedTeam.filter((r) => !r.ghlUserId);
    const nameFallbacks = mappedTeam.filter((r) => r.matchedBy === "name");

    if (nameFallbacks.length) {
      console.warn(
        "[workizWebhook] Matched tech by NAME fallback (id didn't match):",
        nameFallbacks.map((r) => `${r.member.name} (${r.member.id})`).join(", ")
      );
    }
    if (unmapped.length) {
      // Logged so real USR- ids/names can be captured and added to techMap.js.
      console.warn(
        "[workizWebhook] No GHL user mapping for Workiz tech(s):",
        unmapped.map((r) => `${r.member.name || "?"} (${r.member.id})`).join(", ")
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
