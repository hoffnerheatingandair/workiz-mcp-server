import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerWorkizTools } from "./tools.js";
import ghlWebhookRoutes from "./ghlWebhookRoutes.js";

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

app.listen(PORT, () => {
  console.log(`Workiz MCP server listening on port ${PORT}`);
  console.log(`  MCP endpoint: http://localhost:${PORT}/mcp`);
  if (!MCP_SERVER_KEY) {
    console.warn("  WARNING: MCP_SERVER_KEY is not set — server is unauthenticated. Set it before deploying publicly.");
  }
});
