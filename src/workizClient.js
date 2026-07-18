// Thin wrapper around the Workiz REST API.
// Docs: https://developer.workiz.com/
//
// Auth style: the API token is embedded in the URL path, e.g.
//   https://api.workiz.com/api/v1/{API_TOKEN}/job/all/
//
// All functions return parsed JSON and throw on non-2xx responses so tool
// handlers can catch and surface a clean error message to Claude.

const BASE = (process.env.WORKIZ_API_BASE || "https://api.workiz.com/api/v1").replace(/\/$/, "");
const TOKEN = process.env.WORKIZ_API_TOKEN;
// Workiz issues TWO credentials (Settings > Integrations > Developer): the
// API token (URL path, works for reads) and the API secret, which must be
// sent as `auth_secret` in the JSON body of every WRITE. Without it, all
// POST endpoints (job/create, job/update, lead/*, ...) return 401 even
// though reads succeed -- confirmed against the live API 2026-07-17.
const SECRET = process.env.WORKIZ_API_SECRET;

if (!TOKEN) {
  // Don't crash on import (useful for local tool-schema testing), but warn loudly.
  console.warn(
    "[workizClient] WORKIZ_API_TOKEN is not set. Requests to Workiz will fail until it is configured."
  );
}
if (!SECRET) {
  console.warn(
    "[workizClient] WORKIZ_API_SECRET is not set. Workiz WRITE operations (create/update job or lead) will fail with 401 until it is configured."
  );
}

function buildUrl(path, query) {
  const url = new URL(`${BASE}/${TOKEN}/${path.replace(/^\//, "")}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    }
  }
  return url.toString();
}

async function request(method, path, { query, body } = {}) {
  const url = buildUrl(path, query);

  // Writes require the API secret in the body (see note on SECRET above).
  // Injected here centrally so no individual endpoint can forget it.
  let payload = body;
  if (method !== "GET" && SECRET) {
    payload = { ...(body || {}), auth_secret: SECRET };
  }

  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
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
    const err = new Error(`Workiz API ${method} ${path} failed (${res.status}): ${message}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  // Workiz wraps most successful payloads as { flag, data, message }
  return json;
}

// ---------- Jobs ----------
export const getJob = (uuid) => request("GET", `job/get/${uuid}/`);
export const getAllJobs = (query) => request("GET", "job/all/", { query });
// body shape confirmed against a real job/get/ record:
//   FirstName, LastName (two fields, not a combined name)
//   Phone (plain digits, no "+1", e.g. "4128626273")
//   JobDateTime, JobEndDateTime ("YYYY-MM-DD HH:MM:SS" -- space, no "T"/offset)
//   Address, Unit, City, State, PostalCode, Country
//   JobType, JobSource, JobName, JobNotes, Comments (top-level strings)
//   Team ([{ id, Name }, ...] for tech assignment)
// JobTotalPrice, ClientId, Status are Workiz-managed and should not be sent on create.
export const createJob = (body) => request("POST", "job/create/", { body });
export const updateJob = (body) => request("POST", "job/update/", { body });
export const assignJobUser = (body) => request("POST", "job/assign/", { body });
export const unassignJobUser = (body) => request("POST", "job/unassign/", { body });
export const addJobPayment = (uuid, body) => request("POST", `job/addPayment/${uuid}/`, { body });

// ---------- Leads ----------
export const getLead = (uuid) => request("GET", `lead/get/${uuid}/`);
export const getAllLeads = (query) => request("GET", "lead/all/", { query });
export const createLead = (body) => request("POST", "lead/create/", { body });
export const updateLead = (body) => request("POST", "lead/update/", { body });
export const markLeadLost = (uuid) => request("POST", `lead/markLost/${uuid}/`);
export const activateLead = (uuid) => request("POST", `lead/activate/${uuid}/`);
export const assignLeadUser = (body) => request("POST", "lead/assign/", { body });
export const unassignLeadUser = (body) => request("POST", "lead/unassign/", { body });
export const convertLead = (body) => request("POST", "lead/convert/", { body });

// ---------- Team ----------
export const getAllTeam = () => request("GET", "team/all/");
export const getTeamMember = (userId) => request("GET", `team/get/${userId}/`);

// ---------- Time off ----------
export const getTimeOff = (query) => request("GET", "TimeOff/get/", { query });
