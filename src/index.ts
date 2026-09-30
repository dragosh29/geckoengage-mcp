#!/usr/bin/env node
// Gecko Engage MCP server: lets Claude, ChatGPT and other MCP clients work with a Gecko student
// recruitment and engagement account (events, attendances, forms, responses, contacts, labels, campaigns).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GeckoClient, GeckoError, MAX_PER_PAGE, pipe, type Page } from "./client.js";
import * as fmt from "./format.js";

let api: GeckoClient;
try {
  api = new GeckoClient({
    accessToken: process.env.GECKO_ACCESS_TOKEN ?? "",
    refreshToken: process.env.GECKO_REFRESH_TOKEN,
    baseUrl: process.env.GECKO_BASE_URL || undefined,
    tokenUrl: process.env.GECKO_TOKEN_URL || undefined,
    onRefresh: () =>
      console.error(
        "Gecko tokens refreshed. The refresh token in GECKO_REFRESH_TOKEN has now been used and will not work again. The new tokens are kept in memory only: after a restart, create a new API token in Gecko and update GECKO_ACCESS_TOKEN and GECKO_REFRESH_TOKEN.",
      ),
  });
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const allowWrites = /^(1|true|yes)$/i.test(process.env.GECKO_ALLOW_WRITES ?? "");

const server = new McpServer(
  { name: "geckoengage", version: "0.1.0" },
  {
    instructions: [
      "Tools for a Gecko Engage account (student recruitment CRM): events and their sessions, attendances (bookings), forms and form responses, contacts (prospective students), labels and campaigns.",
      "All IDs are numbers, except that a contact can also be identified by its 26-character ULID.",
      "Typical flow for 'how many are booked on Saturday's open day?': list_events with a keyword, then list_attendances with the event id.",
      "Contacts are prospective students, many of them under 18: tools return names and IDs only unless include_contact_details is set, and should only be asked for more when the user needs it.",
      "Lists are paginated: when a result says complete: false, call again with page set to next_page and the same per_page.",
    ].join("\n"),
  },
);

const READ = { readOnlyHint: true, openWorldHint: true } as const;

type Json = Record<string, unknown> | unknown[];
const ok = (data: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof GeckoError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}` }],
});
const safe = <A>(fn: (args: A) => Promise<Json>) => async (args: A) => {
  try {
    return ok(await fn(args));
  } catch (err) {
    return fail(err);
  }
};

// Every ID on the endpoints used here is an integer in the spec, except GET /contacts/{id}, which
// takes "Numeric contact ID or contact ULID".
const id = (what: string) => z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(`${what} ID (a positive whole number)`);
const contactRef = z
  .string()
  .regex(/^(\d{1,15}|[0-9A-Za-z]{26})$/, "Contact IDs are numeric (e.g. 445038) or a 26-character ULID (e.g. 01GWP2KQP7CDZWHKV6B56XPGBQ)")
  .describe("Numeric contact ID or the contact's 26-character ULID");
const includeContact = (what: string) => z.boolean().default(false).describe(`Include ${what}. Contacts are often under 18: only ask when the user needs it.`);
const paging = {
  page: z.number().int().min(1).default(1).describe("First page to fetch (use next_page from a previous call to continue)"),
  per_page: z.number().int().min(1).max(MAX_PER_PAGE).default(50).describe("Records per page; keep it the same when continuing"),
  max_pages: z.number().int().min(1).max(20).default(4).describe("How many pages to fetch in this call"),
};
// Free-text filters: surrounding spaces are dropped, and a filter that is only spaces is refused
// rather than sent.
const text = (max = 200) => z.string().trim().min(1, "Must not be empty or only spaces").max(max);
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((d) => {
    const t = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
  }, "Not a real calendar date");

type ListResult = Awaited<ReturnType<GeckoClient["list"]>>;
const pageInfo = (r: ListResult, per_page: number) => ({
  count: r.items.length,
  total: r.total,
  last_page: r.last_page,
  complete: r.complete,
  next_page: r.next_page,
  note: r.complete ? undefined : `More results exist: call again with page ${r.next_page} and per_page ${per_page}.`,
});
const getPage = (path: string, query: Record<string, string | number | boolean | undefined>) => (page: number, perPage: number) =>
  api.get<Page<any>>(path, { ...query, page, per_page: perPage });

server.registerTool(
  "whoami",
  {
    title: "Who am I",
    description: "The Gecko user the API token belongs to, the token's region and expiry times, and which API scopes (permissions) the token has. Use it when a call is refused with 403.",
    inputSchema: { include_contact_details: z.boolean().default(false).describe("Include the user's email address") },
    annotations: READ,
  },
  safe(async ({ include_contact_details }) => {
    const me = await api.get("/auth/user");
    const scopes = await api.get("/auth/scopes");
    return { user: fmt.user(me?.user ?? {}, include_contact_details), token: api.tokenInfo(), scopes: fmt.scopes(scopes) };
  }),
);

server.registerTool(
  "list_events",
  {
    title: "List events",
    description:
      "Events, sessions and session times on the account with their schedule, delivery method, capacity and the number of attendances and form responses. Filters are passed to GET /events as documented. Start and end are 'Y-m-d H:i:s' in the event's own timezone.",
    inputSchema: {
      keyword: text().optional().describe("Free text matched against event title, internal title and country"),
      status: z
        .array(z.enum(["past", "current", "future", "active", "available"]))
        .optional()
        .describe("Schedule states (any of): past (ended 3+ days ago), current, future (not started or started in the last 3 days), active (not ended or ended in the last 3 days), available (not ended yet)"),
      types: z.array(z.enum(["event", "session", "session_time", "legacy_event", "legacy_session"])).optional().describe("Only these record types (top-level events are 'event')"),
      category_ids: z.array(id("Category")).optional().describe("Only events in any of these categories"),
      delivery_methods: z.array(z.enum(["venue", "online", "hybrid"])).optional(),
      parent_id: id("Parent event").optional().describe("Only the sessions of this event"),
      include_contact_details: z.boolean().default(false).describe("Stop redacting email addresses and phone numbers typed into titles, tags and the country"),
      ...paging,
    },
    annotations: READ,
  },
  safe(async ({ keyword, status, types, category_ids, delivery_methods, parent_id, include_contact_details, page, per_page, max_pages }) => {
    const r = await api.list(
      getPage("/events", {
        keyword,
        status: pipe(status),
        type: pipe(types?.map((t) => fmt.EVENT_TYPES[t])),
        // Spec: category_id takes "a single ID such as 2, or a comma-separated string such as 2,3".
        category_id: category_ids?.length ? category_ids.join(",") : undefined,
        delivery_method: pipe(delivery_methods),
        parent_id,
        counts: "attendances,responses",
        // Spec: tags are an extra field returned only when asked for with event_rfields.
        event_rfields: "tags",
      }),
      { startPage: page, perPage: per_page, maxPages: max_pages },
    );
    return { ...pageInfo(r, per_page), events: r.items.map((e) => fmt.event(e, include_contact_details)) };
  }),
);

server.registerTool(
  "get_event",
  {
    title: "Get an event",
    description: "One event with its description (as plain text), location, categories, sessions and session times, and the number of attendances and form responses.",
    inputSchema: {
      event_id: id("Event"),
      include_contact_details: z.boolean().default(false).describe("Stop redacting email addresses and phone numbers in the description and titles"),
    },
    annotations: READ,
  },
  safe(async ({ event_id, include_contact_details }) => {
    const res = await api.get(`/events/${event_id}`, { include: "children,location,categories", counts: "attendances,responses", event_rfields: "tags" });
    return { event: fmt.eventDetail(res?.event ?? {}, include_contact_details) };
  }),
);

server.registerTool(
  "list_attendances",
  {
    title: "List attendances",
    description:
      "Bookings (attendances) for an event, or a contact's bookings across events, with status (Registered, Invited, Attended, Engaged, Waitlisted, Removed, Cancelled, Did not attend), guest count and a count per status. Attendees are shown by contact ID and name; email only with include_contact_details. Payment details and attendees' personal links are never returned.",
    inputSchema: {
      event_id: id("Event").optional().describe("Bookings for this event"),
      contact_id: id("Contact").optional().describe("Bookings made by this contact"),
      statuses: z.array(z.enum(["registered", "invited", "attended", "engaged", "waitlisted", "removed", "cancelled", "did_not_attend"])).optional().describe("Only these statuses"),
      include_contact_details: includeContact("attendees' email addresses"),
      ...paging,
    },
    annotations: READ,
  },
  safe(async ({ event_id, contact_id, statuses, include_contact_details, page, per_page, max_pages }) => {
    if (event_id === undefined && contact_id === undefined) throw new GeckoError("Give an event_id, a contact_id, or both.");
    const r = await api.list(
      getPage("/attendances", { event_id, contact_id, status: pipe(statuses?.map((s) => fmt.ATTENDANCE_STATUSES[s])), include: "contact,event" }),
      { startPage: page, perPage: per_page, maxPages: max_pages },
    );
    const attendances = r.items.map((a) => fmt.attendance(a, include_contact_details));
    const by_status: Record<string, number> = {};
    for (const a of attendances) if (a.status) by_status[a.status] = (by_status[a.status] ?? 0) + 1;
    return { ...pageInfo(r, per_page), by_status_in_this_result: by_status, attendances };
  }),
);

server.registerTool(
  "list_forms",
  {
    title: "List forms",
    description: "Forms on the account (enquiry, event registration, application, chat and other modules) with published, expired and full flags and the number of responses each has.",
    inputSchema: {
      keyword: text().optional().describe("Matched against the form name, internal name and UUID"),
      modules: z.array(z.enum(["application", "call", "chat", "email", "event", "form", "sms", "whatsapp"])).optional(),
      published: z.boolean().optional().describe("Only published (true) or unpublished (false) forms"),
      group: text()
        .refine((g) => !/^@.*\|/.test(g), "A group name that starts with '@' and contains '|' would be read by Gecko as several groups; this tool takes one group")
        .optional()
        .describe("Only forms in this form group (one group name)"),
      ...paging,
    },
    annotations: READ,
  },
  safe(async ({ keyword, modules, published, group, page, per_page, max_pages }) => {
    const r = await api.list(
      getPage("/forms", { keyword, module: pipe(modules), published: published === undefined ? undefined : published ? 1 : 0, group, counts: "responses" }),
      { startPage: page, perPage: per_page, maxPages: max_pages },
    );
    return { ...pageInfo(r, per_page), forms: r.items.map(fmt.form) };
  }),
);

server.registerTool(
  "list_form_responses",
  {
    title: "List form responses",
    description:
      "Form submissions with their form, contact ID, status (draft or completed), labels and submission time. The answers themselves are not fetched; the email stored on a response only with include_contact_details. As the API does by default, quarantined responses are excluded, and so are responses to application-module forms: set module to 'application' to list those instead (list_forms shows each form's module).",
    inputSchema: {
      form_ids: z.array(id("Form")).optional().describe("Only responses to any of these forms"),
      label_ids: z.array(id("Label")).optional().describe("Only responses with any of these labels"),
      module: z
        .enum(["application", "call", "chat", "email", "event", "form", "sms", "whatsapp"])
        .optional()
        .describe("Only responses to forms of this one module. Gecko leaves out application-module responses unless this is 'application'."),
      keyword: text().optional().describe("Matched against response content and the matched contact's details"),
      include_contact_details: includeContact("the email address stored on each response, and stop redacting emails and phone numbers in label names"),
      ...paging,
    },
    annotations: READ,
  },
  safe(async ({ form_ids, label_ids, module, keyword, include_contact_details, page, per_page, max_pages }) => {
    // Spec: label_ids is an extra computed field returned only when asked for with response_rfields.
    const query = { form_id: pipe(form_ids), label: pipe(label_ids), module, response_keyword: keyword, include: "labels", response_rfields: "label_ids" };
    const r = await api.list(getPage("/responses", query), {
      startPage: page,
      perPage: per_page,
      maxPages: max_pages,
    });
    return { ...pageInfo(r, per_page), responses: r.items.map((x) => fmt.response(x, include_contact_details)) };
  }),
);

server.registerTool(
  "search_contacts",
  {
    title: "Search contacts",
    description:
      "Find contacts (prospective students) by keyword, label, event booking or email (whether the email match is exact or partial is not documented), using the documented POST /contacts/search (a read: it changes nothing). Returns contact ID, ULID, name, labels and number of form responses; the email only with include_contact_details. A match on an email or keyword still confirms such a contact exists.",
    inputSchema: {
      keyword: text().optional().describe("Free-text search"),
      label_ids: z.array(id("Label")).optional().describe("Contacts with any of these labels (see list_labels)"),
      attendance_event_id: id("Event").optional().describe("Contacts with an attendance on this event"),
      email: text(320).optional().describe("Email address to look for"),
      include_contact_details: includeContact("email addresses, and stop redacting emails and phone numbers typed into names"),
      ...paging,
    },
    annotations: READ,
  },
  safe(async ({ keyword, label_ids, attendance_event_id, email, include_contact_details, page, per_page, max_pages }) => {
    const r = await api.list(
      (p, pp) =>
        api.request<Page<any>>("POST", "/contacts/search", {
          body: {
            page: p,
            per_page: pp,
            include: "labels",
            ...(keyword ? { keyword } : {}),
            ...(label_ids?.length ? { label: pipe(label_ids) } : {}),
            ...(attendance_event_id !== undefined ? { attendance_event_id } : {}),
            ...(email ? { email } : {}),
          },
        }),
      { startPage: page, perPage: per_page, maxPages: max_pages },
    );
    return { ...pageInfo(r, per_page), contacts: r.items.map((c) => fmt.contactSummary(c, include_contact_details)) };
  }),
);

server.registerTool(
  "get_contact",
  {
    title: "Get a contact",
    description:
      "One contact: name, labels, preferred language and how many form responses and attendances they have. Their contact fields (which hold email, phone, address, date of birth, school and similar) are only returned with include_contact_details; fields that look like bank, card or payment data are never returned. Use list_attendances with the contact_id for their bookings.",
    inputSchema: {
      contact_id: contactRef,
      include_contact_details: includeContact("the email address and every contact field value"),
    },
    annotations: READ,
  },
  safe(async ({ contact_id, include_contact_details }) => {
    const res = await api.get(`/contacts/${contact_id}`, { include: include_contact_details ? "labels,current_values.field" : "labels", counts: "attendances,responses" });
    return { contact: fmt.contactDetail(res?.contact ?? {}, include_contact_details) };
  }),
);

server.registerTool(
  "list_labels",
  {
    title: "List labels",
    description: "Labels (tags) on the account, with their IDs for search_contacts and list_form_responses.",
    inputSchema: {
      keyword: text().optional().describe("Matched against label names"),
      ...paging,
    },
    annotations: READ,
  },
  safe(async ({ keyword, page, per_page, max_pages }) => {
    const r = await api.list(getPage("/labels", { keyword }), { startPage: page, perPage: per_page, maxPages: max_pages });
    return { ...pageInfo(r, per_page), labels: r.items.map(fmt.label) };
  }),
);

server.registerTool(
  "list_campaigns",
  {
    title: "List campaigns",
    description: "Email, SMS, WhatsApp, call and chat campaigns with status, schedule and number of subscribers.",
    inputSchema: {
      keyword: text().optional().describe("Matched against campaign titles and descriptions"),
      statuses: z.array(z.enum(["pending", "active", "running", "complete", "paused", "cancelled", "invalid"])).optional(),
      modules: z.array(z.enum(["call", "email", "sms", "chat", "whatsapp"])).optional(),
      ...paging,
    },
    annotations: READ,
  },
  safe(async ({ keyword, statuses, modules, page, per_page, max_pages }) => {
    const r = await api.list(
      getPage("/campaigns", { keyword, status: pipe(statuses?.map((s) => fmt.CAMPAIGN_STATUSES[s])), module: pipe(modules), counts: "subscribers" }),
      { startPage: page, perPage: per_page, maxPages: max_pages },
    );
    return { ...pageInfo(r, per_page), campaigns: r.items.map(fmt.campaign) };
  }),
);

server.registerTool(
  "get_campaign_stats",
  {
    title: "Campaign delivery and read stats",
    description:
      "Delivery and read (open) statistics for a WhatsApp broadcast campaign over a date range, in total and per hour, day, week or month. The API documents this endpoint for WhatsApp broadcast campaigns only.",
    inputSchema: {
      campaign_id: id("Campaign"),
      from: dateOnly.describe("First day, YYYY-MM-DD (from its start, 00:00:00)"),
      to: dateOnly.describe("Last day, YYYY-MM-DD (to its end: sent as 23:59:59 on that day)"),
      group: z.enum(["hourly", "daily", "weekly", "monthly"]).default("daily"),
    },
    annotations: READ,
  },
  safe(async ({ campaign_id, from, to, group }) => {
    if (to < from) throw new GeckoError(`The range ends (${to}) before it starts (${from}).`);
    // Spec: `from` and `to` are the inclusive ends of the range, "a Unix timestamp or a parseable
    // date/time string"; its example `to` is 23:59:59 on the last day. A bare date would most likely be
    // read as midnight at the start of that day, so the last day is sent with its end-of-day time.
    const res = await api.get(`/campaigns/${campaign_id}/stats`, { from: `${from} 00:00:00`, to: `${to} 23:59:59`, group });
    return { stats: fmt.campaignStats(res) };
  }),
);

if (allowWrites) {
  server.registerTool(
    "register_contact_for_event",
    {
      title: "Register a contact for an event",
      description:
        "Book a contact onto an event or session (or onto its waitlist), with the same capacity, waitlist and guest rules as the registration flow. The API call is 'create or update', so the tool first looks up the contact's attendances on that event, including deleted ones, and refuses if there is any. That check is a separate read just before the booking: two calls for the same contact and event at the same moment could both pass it. Gecko may send the event's confirmation messages and run its workflows. If Gecko answers with a gateway error the call is NOT retried: check list_attendances before trying again. Only available when GECKO_ALLOW_WRITES=true.",
      inputSchema: {
        contact_id: id("Contact"),
        event_id: id("Event"),
        waitlist: z.boolean().default(false).describe("Put the contact on the waitlist instead of registering them"),
        guest_count: z.number().int().min(0).max(100).optional().describe("Number of guests coming with the contact"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async ({ contact_id, event_id, waitlist, guest_count }) => {
      // POST /attendances is "create or update"; look first (soft-deleted attendances included, with the
      // documented trashed=1) so an existing booking is not changed. Best effort: not atomic with the POST.
      const existing = await api.get<Page<any>>("/attendances", { contact_id, event_id, trashed: 1, page: 1, per_page: 1 });
      const current = Array.isArray(existing?.data) ? existing.data[0] : undefined;
      if (current) {
        const a = fmt.attendance(current, false);
        throw new GeckoError(`Not registered: contact ${contact_id} already has an attendance on event ${event_id} (attendance ${a.id}, status ${a.status}). This tool only creates new bookings, and the check includes deleted attendances.`);
      }
      // Body: Attendances_AttendanceStoreRequest; status accepts the attendee-facing "yes" and "waitlist".
      const res = await api.request("POST", "/attendances", {
        body: { contact_id, event_id, status: waitlist ? "waitlist" : "yes", ...(guest_count !== undefined ? { guest_count } : {}) },
      });
      return { result: waitlist ? "added to the waitlist" : "registered", attendance: fmt.attendance(res?.attendance ?? {}, false) };
    }),
  );

  server.registerTool(
    "add_contact_label",
    {
      title: "Add a label to a contact",
      description:
        "Add an existing label (see list_labels) to a contact, keeping the labels they already have. The API only offers 'replace the contact's labels', so the tool reads the current labels and sends them back with the new one; a label someone else adds or removes in between can be overwritten, hence the destructive annotation. Nothing is sent if the contact already has the label. Only available when GECKO_ALLOW_WRITES=true.",
      inputSchema: {
        contact_id: id("Contact"),
        label_id: id("Label"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    safe(async ({ contact_id, label_id }) => {
      const labels = await api.get<Page<any>>("/labels", { id: label_id, page: 1, per_page: 1 });
      const target = Array.isArray(labels?.data) ? labels.data.find((l: any) => Number(l?.id) === label_id) : undefined;
      if (!target) throw new GeckoError(`Label ${label_id} does not exist on this account. Use list_labels to find the right ID.`);
      const res = await api.get(`/contacts/${contact_id}`, { include: "labels" });
      const currentIds: number[] = Array.isArray(res?.contact?.labels) ? res.contact.labels.map((l: any) => Number(l?.id)).filter((n: number) => Number.isInteger(n) && n > 0) : [];
      if (currentIds.includes(label_id)) {
        return { result: "unchanged: the contact already has this label", contact: fmt.contactSummary(res.contact, false) };
      }
      // Body: Contacts_ReplaceLabelsRequest, "Labels that should remain attached to the contact after replacement".
      const updated = await api.request("POST", `/contacts/${contact_id}/replace_labels`, { body: { labels: [...currentIds, label_id], include: "labels" } });
      return { result: `label "${fmt.label(target).name}" added`, contact: fmt.contactSummary(updated?.contact ?? {}, false) };
    }),
  );
}

await server.connect(new StdioServerTransport());
console.error(`Gecko Engage MCP server running (writes ${allowWrites ? "enabled" : "disabled"}).`);
