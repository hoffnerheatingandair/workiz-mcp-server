import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "workiz-hardening-"));
const nativeFetch = global.fetch;
Object.assign(process.env, {
  MCP_SERVER_KEY: "mcp-test-key",
  GHL_WEBHOOK_SECRET: "ghl-hook-key",
  WORKIZ_WEBHOOK_SECRET: "workiz-hook-key",
  WORKIZ_API_TOKEN: "workiz-token",
  WORKIZ_API_SECRET: "workiz-secret",
  WORKIZ_API_BASE: "https://workiz.test/api/v1",
  GHL_PIT: "ghl-token",
  GHL_LOC: "ghl-location",
  GHL_API_BASE: "https://ghl.test",
  GHL_BLOCK_STORE_PATH: path.join(tempDir, "blocks.json"),
  WORKIZ_MIN_REQUEST_INTERVAL_MS: "0",
  WORKIZ_429_BACKOFF_MS: "1",
});

const { app } = await import("../src/server.js");
const { isNewSystemEstimate, resetBookingDedupeForTest } = await import("../src/ghlWebhookRoutes.js");
const { resetWorkizRateLimitForTest } = await import("../src/workizRateLimit.js");

let server;
let base;
let calls;

before(() => new Promise((resolve) => {
  server = app.listen(0, "127.0.0.1", () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

beforeEach(async () => {
  calls = [];
  resetBookingDedupeForTest();
  resetWorkizRateLimitForTest();
  await fs.rm(process.env.GHL_BLOCK_STORE_PATH, { force: true });
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("job/create")) return Response.json({ data: { UUID: "JOB-1" } });
    if (String(url).includes("block-slots") && options.method === "POST") {
      return Response.json({ id: `BLOCK-${calls.length}` });
    }
    return Response.json({ ok: true });
  };
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function post(route, secret, body) {
  return nativeFetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
}

test("GHL booking creates one Workiz job and suppresses duplicate delivery", async () => {
  const payload = {
    contact: { id: "CONTACT-1", firstName: "Jane", lastName: "Doe", phone: "+14125550100" },
    appointment: { id: "APPT-1", startTime: "2026-09-16T14:00:00Z", endTime: "2026-09-16T15:00:00Z" },
    jobType: { name: "New System Estimate" },
  };
  const first = await post("/webhooks/ghl/booking", "ghl-hook-key", payload);
  const second = await post("/webhooks/ghl/booking", "ghl-hook-key", payload);
  assert.equal(first.status, 200);
  assert.equal((await second.json()).duplicate, true);
  const creates = calls.filter((call) => call.url.includes("job/create"));
  assert.equal(creates.length, 1);
  const sent = JSON.parse(creates[0].options.body);
  assert.equal(sent.JobType, "New System Estimate");
  assert.equal(sent.Phone, "4125550100");
});

test("New System Estimate is detected for string and object job types", () => {
  assert.equal(isNewSystemEstimate("New System Estimate"), true);
  assert.equal(isNewSystemEstimate({ name: "New System Estimate" }), true);
  assert.equal(isNewSystemEstimate({ Name: "New System Estimate" }), true);
  assert.equal(isNewSystemEstimate({ name: "Repair" }), false);
});

test("Workiz reschedule, technician change, and cancellation update GHL blocks", async () => {
  const job = (trigger, team, date = "2026-09-16 10:00:00") => ({
    trigger: { type: trigger },
    data: { uuid: "JOB-2", status: "Scheduled", date, endDate: "2026-09-16 11:00:00", team,
      firstName: "Jane", lastName: "Doe", jobType: { name: "Repair" } },
  });
  const todd = [{ id: "USR-G8ye2JvdggXxgAdj", name: "Todd Kinsey" }];
  const james = [{ id: "USR-DvjZwLkyYmWMmVBA", name: "James Pfeiffer" }];
  assert.equal((await post("/webhooks/workiz/job", "workiz-hook-key", job("job_created", todd))).status, 200);
  assert.equal((await post("/webhooks/workiz/job", "workiz-hook-key", job("job_updated", todd, "2026-09-16 12:00:00"))).status, 200);
  assert.equal((await post("/webhooks/workiz/job", "workiz-hook-key", job("job_updated", james))).status, 200);
  assert.equal((await post("/webhooks/workiz/job", "workiz-hook-key", job("job_canceled", james))).status, 200);
  assert.ok(calls.some((call) => call.options.method === "PUT"));
  assert.ok(calls.filter((call) => call.options.method === "DELETE").length >= 2);
});

test("Workiz lead creates a GHL contact", async () => {
  const response = await post("/webhooks/workiz/lead", "workiz-hook-key", {
    data: { firstName: "Jane", lastName: "Doe", phone: "4125550100", email: "jane@example.test" },
  });
  assert.equal(response.status, 200);
  const create = calls.find((call) => call.url.endsWith("/contacts/"));
  assert.ok(create);
  const sent = JSON.parse(create.options.body);
  assert.equal(sent.phone, "+14125550100");
  assert.equal(sent.locationId, "ghl-location");
});

test("Workiz 429 responses retry through the shared budget", async () => {
  let attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    return attempts < 3
      ? new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
      : Response.json({ data: [] });
  };
  const { getAllJobs } = await import("../src/workizClient.js");
  const result = await getAllJobs({ records: 1 });
  assert.deepEqual(result.data, []);
  assert.equal(attempts, 3);
});

test("protected routes fail closed when their secret is absent", async () => {
  const old = process.env.WORKIZ_WEBHOOK_SECRET;
  delete process.env.WORKIZ_WEBHOOK_SECRET;
  const response = await post("/webhooks/workiz/job", "anything", {});
  process.env.WORKIZ_WEBHOOK_SECRET = old;
  assert.equal(response.status, 500);
  assert.equal((await response.json()).ok, false);
});

test("admin route rejects unauthenticated access", async () => {
  const response = await nativeFetch(`${base}/api/jobs`);
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test("MCP and admin routes return unavailable when MCP secret is missing", async () => {
  const old = process.env.MCP_SERVER_KEY;
  delete process.env.MCP_SERVER_KEY;
  const [mcp, admin] = await Promise.all([
    nativeFetch(`${base}/mcp`),
    nativeFetch(`${base}/api/jobs`),
  ]);
  process.env.MCP_SERVER_KEY = old;
  assert.equal(mcp.status, 503);
  assert.equal(admin.status, 503);
});
