# Workiz MCP Server

A remote MCP (Model Context Protocol) server that exposes your Workiz CRM/Field
Service data — jobs, leads, team, time off — as tools Claude can call directly.
Once deployed and added as a custom connector, you can ask Claude things like:

> "Pull all leads from the last 30 days and flag any where the lead source
> looks miscategorized, then fix the ones you're confident about."

and it will call these tools to read and write your Workiz data.

## What this does / doesn't do

- ✅ Read and write existing Workiz records (jobs, leads) via the same
  endpoints Workiz's own integrations use.
- ✅ Create leads, convert leads to jobs, assign/unassign team members, log
  payments, pull team & time-off data.
- ❌ Does **not** let you create new object types or custom modules inside
  Workiz itself — it only reads/writes fields that already exist on your
  account (including custom fields, once you know their names).

## 1. Get your Workiz credentials

1. In Workiz, open **Feature Center** and enable the **Developer API** add-on.
2. Go to your profile icon > **Settings** > **Integrations** > **Developer**.
3. Copy the **API token**.

## 2. Local setup

```bash
cd workiz-mcp-server
npm install
cp .env.example .env
```

Edit `.env`:

```
WORKIZ_API_TOKEN=<paste your token>
MCP_SERVER_KEY=<make up a long random string>
```

Run it locally:

```bash
npm start
```

You should see:

```
Workiz MCP server listening on port 3000
  MCP endpoint: http://localhost:3000/mcp
```

### Test locally before deploying

Use the official MCP Inspector to sanity-check the tools without needing a
public URL yet:

```bash
npx @modelcontextprotocol/inspector
```

Point it at `http://localhost:3000/mcp`, set the Authorization header to
`Bearer <your MCP_SERVER_KEY>`, and try calling `workiz_list_jobs` or
`workiz_list_team` to confirm your token works and see real field names
(including any custom fields) for your account.

## 3. Deploy it somewhere public

Claude connects to custom connectors from Anthropic's cloud, **not** your
laptop, so the server needs a public URL. Pick whichever you're comfortable
with — this code is plain Node/Express, so any of these work with no changes:

- **Render** (`render.com`) — easiest: "New Web Service" > connect this repo >
  build command `npm install`, start command `npm start` > add the two env
  vars in the dashboard.
- **Railway** (`railway.app`) — similar one-click flow.
- **Fly.io** — `fly launch`, then `fly secrets set WORKIZ_API_TOKEN=... MCP_SERVER_KEY=...`.
- **Cloudflare Workers** — possible but requires adapting the Express app to
  Workers' fetch-handler style; use one of the above if you want the code as-is
  to just work.

Whichever you choose, set `WORKIZ_API_TOKEN` and `MCP_SERVER_KEY` as
environment variables/secrets in that platform's dashboard — never commit
`.env` to source control.

After deploying, confirm `https://your-app-url/health` returns `{"status":"ok"}`.

## 4. Add it to Claude as a custom connector

1. In Claude (claude.ai, Cowork, or the app), go to **Settings/Customize >
   Connectors**. (Team/Enterprise: an Owner does this once under
   **Organization Settings > Connectors**, then members connect individually.)
2. Click **+ Add custom connector**.
3. Enter your server's MCP URL: `https://your-app-url/mcp`
4. Under **Advanced settings**, there's no standard field for a raw bearer
   token in every client version — if you don't see one, the simplest
   workaround is to temporarily leave `MCP_SERVER_KEY` unset for initial
   testing (fine short-term, not for production), or front the server with an
   OAuth layer later. If your Claude client does expose a token/header field,
   put your `MCP_SERVER_KEY` value there.
5. Click **Add**, then enable the connector for your conversation via the
   "+" button > Connectors.

## 5. Recommended workflow for the "miscategorized data" cleanup

1. Ask Claude (in Cowork or claude.ai, connector enabled) to call
   `workiz_list_jobs` or `workiz_list_leads` for a date range.
2. Have it summarize/flag records it thinks are miscategorized, and show you
   its reasoning before changing anything.
3. Review the proposed changes.
4. Approve, and have Claude call `workiz_update_job` / `workiz_update_lead`
   for the confirmed corrections.

This keeps a human in the loop rather than letting bulk writes happen
unsupervised — Workiz has no "undo" for bulk API updates.

## Notes & limitations

- Workiz's rate limits aren't fully published; if you get HTTP 429s, back off
  and retry. Consider adding request throttling in `workizClient.js` if you'll
  be paging through large datasets.
- Custom field names vary by Workiz account — call `workiz_get_job` /
  `workiz_get_lead` on a real record first to see your actual field names
  before writing update logic that depends on them.
- This server currently exposes one tool per Workiz endpoint (a "thin"
  wrapper). If you want higher-level tools later (e.g. a single
  `workiz_find_miscategorized_leads` tool with your team's specific
  business rules baked in), that logic is best added as an additional tool
  in `src/tools.js` once we know the exact rules you want applied.
