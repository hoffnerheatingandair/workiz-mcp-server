import { z } from "zod";
import * as workiz from "./workizClient.js";

// Every handler returns MCP "content" blocks. We stringify JSON results so
// Claude can read/reason over the structured data.
function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function fail(err) {
  return {
    content: [{ type: "text", text: `Error: ${err.message}` }],
    isError: true,
  };
}

// Registers all Workiz tools on an McpServer instance.
export function registerWorkizTools(server) {
  // ---------------- JOBS ----------------

  server.tool(
    "workiz_list_jobs",
    "List/search Workiz jobs. Supports Workiz's native filters (e.g. status, date range, team). " +
      "Use this to pull a batch of jobs for review, e.g. to find miscategorized or stale records. " +
      "Results are paginated by Workiz; call again with a different offset/start_date to page through.",
    {
      start_date: z.string().optional().describe("Filter jobs created/updated on or after this date, format YYYY-MM-DD"),
      end_date: z.string().optional().describe("Filter jobs on or before this date, format YYYY-MM-DD"),
      status: z.string().optional().describe("Workiz job status to filter by, e.g. 'Pending', 'Completed'"),
      offset: z.number().optional().describe("Pagination offset"),
      records: z.number().optional().describe("Number of records to return per page"),
    },
    async (args) => {
      try {
        return ok(await workiz.getAllJobs(args));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "workiz_get_job",
    "Get full details for a single Workiz job by its UUID.",
    { UUID: z.string().describe("The job's UUID") },
    async ({ UUID }) => {
      try {
        return ok(await workiz.getJob(UUID));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "workiz_update_job",
    "Update fields on an existing Workiz job (e.g. fix a miscategorized status, job type, or custom field). " +
      "Pass the job's UUID plus a flat object of field:value pairs to change. " +
      "Tip: call workiz_get_job first to see the exact field names in use on your account, since some fields " +
      "(especially custom fields) vary by tenant.",
    {
      UUID: z.string().describe("The job's UUID"),
      updates: z.record(z.any()).describe("Object of field names to new values, e.g. { \"Status\": \"Completed\", \"JobType\": \"Repair\" }"),
    },
    async ({ UUID, updates }) => {
      try {
        return ok(await workiz.updateJob({ UUID, ...updates }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "workiz_assign_job",
    "Assign a team member to a job.",
    {
      UUID: z.string().describe("The job's UUID"),
      UserId: z.string().describe("The user ID of the team member to assign"),
    },
    async ({ UUID, UserId }) => {
      try {
        return ok(await workiz.assignJobUser({ UUID, UserId }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "workiz_unassign_job",
    "Remove a team member's assignment from a job.",
    {
      UUID: z.string().describe("The job's UUID"),
      UserId: z.string().describe("The user ID of the team member to unassign"),
    },
    async ({ UUID, UserId }) => {
      try {
        return ok(await workiz.unassignJobUser({ UUID, UserId }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "workiz_add_job_payment",
    "Record a payment against a job.",
    {
      UUID: z.string().describe("The job's UUID"),
      Amount: z.number().describe("Payment amount"),
      PaymentType: z.string().optional().describe("e.g. 'Cash', 'Card', 'Check'"),
      Note: z.string().optional(),
    },
    async ({ UUID, ...body }) => {
      try {
        return ok(await workiz.addJobPayment(UUID, body));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ---------------- LEADS ----------------

  server.tool(
    "workiz_list_leads",
    "List/search Workiz leads. Useful for reviewing lead source categorization or finding leads stuck in the wrong stage.",
    {
      start_date: z.string().optional().describe("YYYY-MM-DD"),
      end_date: z.string().optional().describe("YYYY-MM-DD"),
      offset: z.number().optional(),
      records: z.number().optional(),
    },
    async (args) => {
      try {
        return ok(await workiz.getAllLeads(args));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "workiz_get_lead",
    "Get full details for a single Workiz lead by its UUID.",
    { UUID: z.string() },
    async ({ UUID }) => {
      try {
        return ok(await workiz.getLead(UUID));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "workiz_create_lead",
    "Create a new lead in Workiz.",
    {
      fields: z.record(z.any()).describe(
        "Flat object of lead fields, e.g. { \"ClientName\": \"Jane Doe\", \"Phone\": \"555-1234\", \"LeadSource\": \"Google Ads\" }"
      ),
    },
    async ({ fields }) => {
      try {
        return ok(await workiz.createLead(fields));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "workiz_update_lead",
    "Update fields on an existing lead (e.g. fix a wrong lead source or stage). Call workiz_get_lead first to confirm field names.",
    {
      UUID: z.string(),
      updates: z.record(z.any()),
    },
    async ({ UUID, updates }) => {
      try {
        return ok(await workiz.updateLead({ UUID, ...updates }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "workiz_mark_lead_lost",
    "Mark a lead as lost.",
    { UUID: z.string() },
    async ({ UUID }) => {
      try {
        return ok(await workiz.markLeadLost(UUID));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "workiz_activate_lead",
    "Re-activate a previously lost lead.",
    { UUID: z.string() },
    async ({ UUID }) => {
      try {
        return ok(await workiz.activateLead(UUID));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "workiz_assign_lead",
    "Assign a team member to a lead.",
    { UUID: z.string(), UserId: z.string() },
    async ({ UUID, UserId }) => {
      try {
        return ok(await workiz.assignLeadUser({ UUID, UserId }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "workiz_unassign_lead",
    "Remove a team member's assignment from a lead.",
    { UUID: z.string(), UserId: z.string() },
    async ({ UUID, UserId }) => {
      try {
        return ok(await workiz.unassignLeadUser({ UUID, UserId }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "workiz_convert_lead",
    "Convert a lead into a job.",
    {
      UUID: z.string().describe("The lead's UUID"),
      extraFields: z.record(z.any()).optional().describe("Optional additional fields required by your account's conversion flow"),
    },
    async ({ UUID, extraFields }) => {
      try {
        return ok(await workiz.convertLead({ UUID, ...(extraFields || {}) }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ---------------- TEAM & TIME OFF ----------------

  server.tool(
    "workiz_list_team",
    "List all team members on the Workiz account.",
    {},
    async () => {
      try {
        return ok(await workiz.getAllTeam());
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "workiz_get_team_member",
    "Get details for a specific team member by user ID.",
    { UserId: z.string() },
    async ({ UserId }) => {
      try {
        return ok(await workiz.getTeamMember(UserId));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.tool(
    "workiz_get_time_off",
    "Get time-off records for the team, optionally filtered by date range.",
    {
      start_date: z.string().optional().describe("YYYY-MM-DD"),
      end_date: z.string().optional().describe("YYYY-MM-DD"),
    },
    async (args) => {
      try {
        return ok(await workiz.getTimeOff(args));
      } catch (e) {
        return fail(e);
      }
    }
  );
}
