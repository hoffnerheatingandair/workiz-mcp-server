import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerWorkizTools } from "./tools.js";
import ghlWebhookRoutes from "./ghlWebhookRoutes.js";
import path from "node:path";
import fs from "node:fs";

const PORT = process.env.PORT || 3000;
const MCP_SERVER_KEY = process.env.MCP_SERVER_KEY;

// ---- Build a fresh McpServer + tool registrations for each session ----
function buildServer() {
  const server = new McpServer({
    name: "workiz-mcp-server",
    version: "1.0.0",
  });
  registerWorkizTools(server);
  return server;
}

const app = express();
app.use(express.json());

// Simple shared-secret auth so random internet traffic can't call your server.
// Claude's custom connector setup lets you supply a Bearer token; put your
// MCP_SERVER_KEY value there. If MCP_SERVER_KEY is unset, auth is skipped
// (fine for local testing only -- always set it before deploying publicly).
function checkAuth(req, res, next) {
  if (!MCP_SERVER_KEY) return next();
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  if (token !== MCP_SERVER_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Map of active sessions, keyed by MCP session id.
const transports = {};

app.post("/mcp", checkAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        transports[newSessionId] = transport;
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };

    const server = buildServer();
    await server.connect(transport);
  } else {
    return res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: missing or invalid session" },
      id: null,
    });
  }

  await transport.handleRequest(req, res, req.body);
});

// Streamable HTTP also uses GET (server->client notifications) and DELETE (session close).
async function handleSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send("Invalid or missing session ID");
  }
  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
}

app.get("/mcp", checkAuth, handleSessionRequest);
app.delete("/mcp", checkAuth, handleSessionRequest);

app.use(ghlWebhookRoutes);

app.get("/health", (req, res) => res.json({ status: "ok" }));
// --- simple in-memory cache so refreshes are instant ---
let jobsCache = { data: null, fetchedAt: 0 };
const JOBS_CACHE_MS = 60 * 1000; // 60 seconds

app.get("/api/jobs", async (req, res) => {
  // Allow the job board (browser) to call this endpoint
  res.set("Access-Control-Allow-Origin", "*");

  try {
    // Serve from cache if it's less than 60s old
    if (jobsCache.data && Date.now() - jobsCache.fetchedAt < JOBS_CACHE_MS) {
      return res.json({ count: jobsCache.data.length, jobs: jobsCache.data, cached: true });
    }

    // >>> CHANGE THIS if your env var has a different name <<<
    const token = process.env.WORKIZ_API_TOKEN;
    if (!token) {
      return res.status(500).json({ error: "WORKIZ_API_TOKEN is not set on Render" });
    }

    // Jobs since January 1st (for YTD stats) or the last 90 days,
    // whichever reaches further back
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const ninetyDays = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const start = (yearStart < ninetyDays ? yearStart : ninetyDays)
      .toISOString()
      .slice(0, 10); // YYYY-MM-DD

    const allJobs = [];
    const seen = new Set();
    let offset = 0;
    let step = 1; // Workiz offset appears to be page-based; verified below
    let requests = 0;

    while (requests < 60) {
      const url =
        `https://api.workiz.com/api/v1/${token}/job/all/` +
        `?start_date=${start}&offset=${offset}&records=100&only_open=false`;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Workiz API returned ${response.status}`);
      }

      const body = await response.json();
      const page = Array.isArray(body.data) ? body.data : [];
      requests++;

      // Add only jobs we haven't seen (dedupe by UUID)
      let added = 0;
      for (const job of page) {
        const id = String(job.UUID || job.SerialId || JSON.stringify(job).length + "-" + allJobs.length);
        if (!seen.has(id)) {
          seen.add(id);
          allJobs.push(job);
          added++;
        }
      }

      // Stop when a page is empty or gave us nothing new
      if (page.length === 0 || added === 0) break;

      // If most of the page was duplicates, offset is record-based —
      // switch to stepping by 100 records instead of by page
      if (added < page.length / 2 && step === 1) step = 100;

      offset += step;
    }

    jobsCache = { data: allJobs, fetchedAt: Date.now() };
    res.json({ count: allJobs.length, jobs: allJobs, cached: false });
  } catch (err) {
    console.error("GET /api/jobs failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/board", (req, res) => {
  const spots = [
    path.join(process.cwd(), "src", "board.html"),
    path.join(process.cwd(), "board.html"),
  ];
  const file = spots.find((p) => fs.existsSync(p));
  if (!file) {
    return res
      .status(500)
      .send("board.html not found. Looked in: " + spots.join(" | "));
  }
  res.sendFile(file);
});
app.listen(PORT, () => {
  console.log(`Workiz MCP server listening on port ${PORT}`);
  console.log(`  MCP endpoint: http://localhost:${PORT}/mcp`);
  if (!MCP_SERVER_KEY) {
    console.warn("  WARNING: MCP_SERVER_KEY is not set — server is unauthenticated. Set it before deploying publicly.");
  }
});
