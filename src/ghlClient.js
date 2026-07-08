// Thin wrapper around the GoHighLevel (GHL) REST API v2.
// Base: https://services.leadconnectorhq.com
//
// Auth style: Bearer token from a GHL Private Integration Token (PIT), scoped
// to a single location (sub-account). Most endpoints also require the
// locationId in the request body/query, and every endpoint requires a
// "Version" header pinned to the API version it was written against.

const BASE = (process.env.GHL_API_BASE || "https://services.leadconnectorhq.com").replace(/\/$/, "");
const PIT = process.env.GHL_PIT;
const LOCATION_ID = process.env.GHL_LOC;

if (!PIT) {
  console.warn("[ghlClient] GHL_PIT is not set. Requests to GHL will fail until it is configured.");
}
if (!LOCATION_ID) {
  console.warn("[ghlClient] GHL_LOC is not set. Requests to GHL will fail until it is configured.");
}

async function request(method, path, { query, body, version } = {}) {
  const url = new URL(`${BASE}${path.startsWith("/") ? path : `/${path}`}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${PIT}`,
      Version: version,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const message = json?.message || json?.error || res.statusText;
    const err = new Error(`GHL API ${method} ${path} failed (${res.status}): ${message}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return json;
}

// ---------- Calendars ----------
// Creates a real appointment on a GHL calendar.
// body: { calendarId, contactId, startTime, endTime, title, ... }
// Docs use API version 2021-04-15 for all /calendars/* endpoints.
export const createCalendarEvent = (body) =>
  request("POST", "/calendars/events/appointments", {
    body: { locationId: LOCATION_ID, ...body },
    version: "2021-04-15",
  });

// Blocks off time so a GHL user can't be double-booked. Per GHL's docs,
// "Either calendarId or assignedUserId can be set, not both" -- pass
// assignedUserId (a GHL user id, not email) with no calendarId to block that
// person across ALL their calendars, rather than just one.
// body: { assignedUserId, startTime, endTime, title }
export const blockSlot = (body) =>
  request("POST", "/calendars/events/block-slots", {
    body: { locationId: LOCATION_ID, ...body },
    version: "2021-04-15",
  });

// Updates/reschedules an existing block slot by its GHL event id.
export const updateBlockSlot = (eventId, body) =>
  request("PUT", `/calendars/events/block-slots/${eventId}`, {
    body: { locationId: LOCATION_ID, ...body },
    version: "2021-04-15",
  });

// Deletes any calendar event by id -- this is GHL's generic event-delete
// endpoint; there is no block-slot-specific delete.
export const deleteCalendarEvent = (eventId) =>
  request("DELETE", `/calendars/events/${eventId}`, { version: "2021-04-15" });

// ---------- Contacts ----------
// Creates a contact. body: { firstName, lastName, email, phone, address1, ... }
// Contacts endpoints use API version 2021-07-28.
export const createContact = (body) =>
  request("POST", "/contacts/", {
    body: { locationId: LOCATION_ID, ...body },
    version: "2021-07-28",
  });
