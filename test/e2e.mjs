// End-to-end test: fixtures are validated against Gecko's published OpenAPI schemas, then the built MCP
// server is driven over stdio by a real MCP client against a local mock of the API and of the GeckoAuth
// token refresh endpoint.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fx from "./fixtures.mjs";
import { startMock, jwt, TOKEN_PATH } from "./mock-server.mjs";

const started = Date.now();
const root = fileURLToPath(new URL("..", import.meta.url));
let passed = 0;
const check = async (name, fn) => {
  try {
    await fn();
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    throw err;
  }
  passed++;
  console.log(`  ok  ${name}`);
};

// 1. Fixtures match the published spec (so the mock returns what the real API documents).
const SPEC_URL = "https://docs.geckoengage.com/openapi/engage-openapi.yml";
if (!existsSync(`${root}spec.yaml`)) {
  try {
    const text = await (await fetch(SPEC_URL)).text();
    assert.match(text, /^openapi: 3\./, "the download is not the OpenAPI document");
    writeFileSync(`${root}spec.yaml`, text);
  } catch (err) {
    console.error(`Could not download the Gecko Engage spec (${err?.cause?.code ?? err.message}). Save it manually:\n  curl -o spec.yaml ${SPEC_URL}`);
    process.exit(1);
  }
}
const spec = parse(readFileSync(`${root}spec.yaml`, "utf8"));
assert.equal(spec.openapi, "3.0.3");

// OpenAPI 3.0 marks nullable values with `nullable: true`, which JSON Schema does not know. Rewrite it
// as a JSON Schema union (adding null to an `enum` too) before handing the components to Ajv.
const denull = (node) => {
  if (Array.isArray(node)) return node.map(denull);
  if (!node || typeof node !== "object") return node;
  const out = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === "properties" ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, denull(pv)])) : denull(v)]));
  if (out.nullable === true) {
    delete out.nullable;
    if (typeof out.type === "string") {
      out.type = [out.type, "null"];
      if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
      return out;
    }
    return { anyOf: [out, { type: "null" }] };
  }
  return out;
};
const components = denull(spec.components);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
for (const f of ["float", "double", "int32", "int64"]) ajv.addFormat(f, true);
ajv.addSchema({ $id: "gk", components });
const inline = (schema) => JSON.parse(JSON.stringify(denull(schema)).replaceAll('"#/components/', '"gk#/components/'));
const validateWith = (schema, obj, label) => {
  const v = typeof schema === "string" ? ajv.getSchema(`gk#/components/schemas/${schema}`) ?? ajv.compile({ $ref: `gk#/components/schemas/${schema}` }) : ajv.compile(inline(schema));
  assert.ok(v(obj), `${label}: ${ajv.errorsText(v.errors)}`);
};
const validate = (schemaName, obj) => validateWith(schemaName, obj, `${schemaName} ${obj?.id ?? ""}`);
const resolve = (o) => (o?.$ref ? o.$ref.split("/").slice(1).reduce((a, k) => a[k], spec) : o);
/** The response schema the spec names for an operation and status (or its `default`). */
const responseSchema = (method, path, status) => {
  const op = spec.paths[path][method.toLowerCase()];
  const r = resolve(op.responses[String(status)] ?? op.responses.default);
  assert.ok(r, `no documented response for ${method} ${path} ${status}`);
  return r.content["application/json"].schema;
};
const requestSchema = (method, path) => resolve(spec.paths[path][method.toLowerCase()].requestBody).content["application/json"].schema;
/**
 * A request body validates against the documented schema, and every key in it is a documented property.
 * The three request schemas used here allow additional properties, so validation alone would not
 * catch an invented or misspelt key.
 */
const validateBody = (method, path, body, label) => {
  const schema = resolve(requestSchema(method, path));
  validateWith(schema, body, label);
  const documented = Object.keys(schema.properties ?? {});
  assert.ok(documented.length > 0, `${method} ${path}: no documented properties`);
  for (const k of Object.keys(body)) assert.ok(documented.includes(k), `${label}: "${k}" is not a documented property of the ${method} ${path} body`);
};
/** The documented query parameter names of an operation (path-level and operation-level). */
const queryParams = (method, path) =>
  [...(spec.paths[path].parameters ?? []), ...(spec.paths[path][method.toLowerCase()].parameters ?? [])].map(resolve).filter((p) => p.in === "query").map((p) => p.name);
const example = (name) => spec.components.examples[name].value;

console.log("fixtures vs OpenAPI spec");
await check("events, attendances, contacts (with current values), forms, responses, labels, campaigns, stats, user and scopes", async () => {
  fx.events.forEach((e) => validate("Events_EventObject", e));
  fx.attendances.forEach((a) => validate("Attendances_Attendance", a));
  fx.contacts.forEach((c) => validate("Contacts_Contact", c));
  validate("Contacts_Contact", { ...fx.contacts[0], current_values: fx.currentValues[fx.PRIYA] });
  fx.forms.forEach((f) => validate("Forms_Form", f));
  fx.responses.forEach((r) => validate("Responses_Response", r));
  fx.labels.forEach((l) => validate("Labels_Label", l));
  fx.campaigns.forEach((c) => validate("Campaigns_Campaign", c));
  validate("Campaigns_CampaignStatsResponse", fx.campaignStats(41, "2026-09-01", "2026-09-07", "daily"));
  validate("Auth_UserSummary", fx.auth.user);
  fx.auth.scopes.forEach((s) => validate("Auth_AuthScope", s));
  // Negative control: the schemas still reject a wrong type.
  const v = ajv.getSchema("gk#/components/schemas/Events_EventObject");
  assert.equal(v({ ...fx.events[0], id: "two" }), false, "a string event id must fail validation");
});

// The refresh endpoint is not in the OpenAPI spec. Its response schema is written here from the
// authentication guide's "Example refresh response" (token values shortened to placeholders).
const REFRESH_RESPONSE_SCHEMA = {
  type: "object",
  required: ["AccessToken", "IdToken", "RefreshToken", "ExpiresIn", "TokenType"],
  properties: { AccessToken: { type: "string" }, IdToken: { type: "string" }, RefreshToken: { type: "string" }, ExpiresIn: { type: "integer" }, TokenType: { type: "null" } },
  additionalProperties: false,
};
const DOCUMENTED_REFRESH_EXAMPLE = { AccessToken: "<access token>", IdToken: "<id token>", RefreshToken: "<refresh token>", ExpiresIn: 1617638510, TokenType: null };

// 2. The mock's responses (lists, single records, writes, errors) match the documented response schemas.
const mock = await startMock();
const { requests, issue, arm, disarm } = mock;
const base = `http://127.0.0.1:${mock.port}`;
const t0 = issue();
const raw = async (method, path, { token = t0.access, body } = {}) => {
  const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
await check("mock responses match the documented list, detail, write and error schemas; the refresh response matches the documented example's shape", async () => {
  const ok = async (method, tpl, path, opts) => {
    const r = await raw(method, path, opts);
    assert.equal(r.status, 200, `${method} ${path} answered ${r.status}: ${JSON.stringify(r.json)}`);
    validateWith(responseSchema(method, tpl, 200), r.json, `${method} ${path}`);
    return r.json;
  };
  const err = async (method, tpl, path, status, opts) => {
    const r = await raw(method, path, opts);
    assert.equal(r.status, status, `${method} ${path}`);
    validateWith(responseSchema(method, tpl, status), r.json, `${method} ${path} ${status}`);
    return r.json;
  };
  await ok("GET", "/auth/user", "/auth/user");
  await ok("GET", "/auth/scopes", "/auth/scopes");
  const events = await ok("GET", "/events", "/events?counts=attendances,responses&per_page=50");
  assert.equal(events.data.length, 6);
  await ok("GET", "/events/{id}", "/events/{id}".replace("{id}", "2") + "?include=children,location,categories&counts=attendances,responses&event_rfields=tags");
  assert.equal((await err("GET", "/events/{id}", "/events/999", 404)).message, "The event you requested is not available.");
  await err("GET", "/events", "/events", 401, { token: jwt({ region: "eu", exp: Math.floor(Date.now() / 1000) + 600 }) });
  const att = await ok("GET", "/attendances", "/attendances?event_id=2&include=contact,event&per_page=50");
  assert.deepEqual([att.total, att.last_page, att.data.length], [fx.OPEN_DAY_ATTENDANCES, 3, 10], "pages are capped at 10");
  const storeBody = { ...example("Attendances_CreateAttendanceRequestExample"), contact_id: 12, event_id: 5 };
  validateBody("POST", "/attendances", storeBody, "POST /attendances documented example body");
  await ok("POST", "/attendances", "/attendances", { body: storeBody });
  mock.attendances.pop(); // undo
  await err("POST", "/attendances", "/attendances", 400, { body: { contact_id: 1, event_id: 1 } });
  await ok("GET", "/forms", "/forms?counts=responses");
  await ok("GET", "/responses", "/responses?include=labels&response_rfields=label_ids");
  await ok("GET", "/responses", "/responses?module=application&include=labels");
  const searchBody = { page: 1, per_page: 50, include: "labels", keyword: "student" };
  validateBody("POST", "/contacts/search", searchBody, "POST /contacts/search body");
  await ok("POST", "/contacts/search", "/contacts/search", { body: searchBody });
  await ok("GET", "/contacts/{id}", `/contacts/${fx.PRIYA}?include=labels,current_values.field&counts=attendances,responses`);
  await ok("GET", "/contacts/{id}", `/contacts/${fx.PRIYA_ULID}?include=labels`);
  assert.equal((await err("GET", "/contacts/{id}", "/contacts/999", 404)).message, example("Contacts_NotFoundExample").message);
  assert.equal((await err("GET", "/contacts/{id}", "/contacts/abc", 400)).message, example("Contacts_BadRequestExample").message);
  const replaceBody = { labels: [1], include: "labels" };
  validateBody("POST", "/contacts/{id}/replace_labels", replaceBody, "replace_labels body");
  await ok("POST", "/contacts/{id}/replace_labels", "/contacts/12/replace_labels", { body: replaceBody });
  await err("POST", "/contacts/{id}/replace_labels", "/contacts/12/replace_labels", 400, { body: { labels: [99] } });
  await ok("GET", "/labels", "/labels?id=2");
  await ok("GET", "/campaigns", "/campaigns?counts=subscribers");
  await ok("GET", "/campaigns/{id}/stats", "/campaigns/41/stats?from=2026-09-01%2000:00:00&to=2026-09-07%2023:59:59&group=daily");
  await err("GET", "/campaigns/{id}/stats", "/campaigns/999/stats?from=2026-09-01&to=2026-09-07", 404);
  // Refresh endpoint: the schema accepts the documented example, and the mock answers in that shape.
  validateWith(REFRESH_RESPONSE_SCHEMA, DOCUMENTED_REFRESH_EXAMPLE, "documented refresh example");
  const spare = issue();
  const refreshed = await fetch(base + TOKEN_PATH, { headers: { Authorization: `Bearer ${spare.refresh}`, Accept: "application/json" } });
  assert.equal(refreshed.status, 200);
  validateWith(REFRESH_RESPONSE_SCHEMA, await refreshed.json(), "mock refresh response");
  assert.equal((await fetch(base + TOKEN_PATH, { headers: { Authorization: `Bearer ${spare.refresh}` } })).status, 401, "a refresh token works once");
});
requests.length = 0; // only count what the MCP server does from here on
arm({ method: "GET", path: "/forms", status: 429, headers: { "Retry-After": "1" }, body: { message: "Too Many Attempts." } });

// 3. Drive the server through MCP. `writes` is the literal GECKO_ALLOW_WRITES value; null leaves it unset.
const connect = async ({ access, refresh, writes = "true", baseUrl = base, stderr }) => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const env = { ...process.env, GECKO_ACCESS_TOKEN: access, GECKO_TOKEN_URL: base + TOKEN_PATH };
  for (const k of ["GECKO_REFRESH_TOKEN", "GECKO_ALLOW_WRITES", "GECKO_BASE_URL"]) delete env[k];
  if (refresh) env.GECKO_REFRESH_TOKEN = refresh;
  if (writes !== null) env.GECKO_ALLOW_WRITES = writes;
  if (baseUrl) env.GECKO_BASE_URL = baseUrl;
  const transport = new StdioClientTransport({ command: process.execPath, args: [`${root}dist/index.js`], env, stderr: stderr ? "pipe" : "ignore" });
  if (stderr) transport.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  await client.connect(transport);
  return client;
};
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? undefined : JSON.parse(res.content[0].text), text: res.content[0].text };
};
const since = (n) => requests.slice(n);
const api = (rs) => rs.filter((r) => r.path !== TOKEN_PATH);

const client = await connect({ access: t0.access, refresh: t0.refresh });
console.log("mcp tools");

const WRITES = ["add_contact_label", "register_contact_for_event"];
await check("tools/list exposes 13 tools; reads are read-only, add_contact_label destructive, register not", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "add_contact_label", "get_campaign_stats", "get_contact", "get_event", "list_attendances", "list_campaigns", "list_events",
    "list_form_responses", "list_forms", "list_labels", "register_contact_for_event", "search_contacts", "whoami",
  ]);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, !WRITES.includes(t.name), `${t.name} readOnlyHint`);
    if (WRITES.includes(t.name)) assert.equal(t.annotations?.destructiveHint, t.name === "add_contact_label", `${t.name} destructiveHint`);
  }
});

await check("whoami returns the user, token region and expiry, and scopes, without the email or any token", async () => {
  const n = requests.length;
  const { data, text } = await call(client, "whoami");
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), ["GET /auth/user", "GET /auth/scopes"]);
  assert.equal(data.user.name, "Admissions API User");
  assert.equal(data.user.email, undefined);
  assert.equal(data.token.region, "eu");
  assert.equal(data.token.api, base);
  assert.equal(data.token.refresh_token_configured, true);
  assert.equal(data.token.access_token_expires, new Date(t0.exp * 1000).toISOString());
  assert.deepEqual(data.scopes, { available: ["events_view", "contacts_view"], unavailable: ["users_delete"] });
  for (const secret of [t0.access, t0.refresh, t0.access.split(".")[1]]) assert.ok(!text.includes(secret), "a token leaked into the output");
  const withEmail = await call(client, "whoami", { include_contact_details: true });
  assert.equal(withEmail.data.user.email, "api.user@example.ac.uk");
});

await check("list_events passes keyword, status, type, category_id, delivery_method and counts exactly as documented", async () => {
  const { data } = await call(client, "list_events", { keyword: "open", status: ["future", "active"], types: ["event"], category_ids: [2, 3], delivery_methods: ["venue", "online"] });
  assert.deepEqual(requests.at(-1).query, { keyword: "open", status: "@future|active", type: "10", category_id: "2,3", delivery_method: "@venue|online", counts: "attendances,responses", event_rfields: "tags", page: "1", per_page: "50" });
  assert.deepEqual(data.events.map((e) => e.id), [2, 3]);
  assert.deepEqual([data.events[0].title, data.events[0].type, data.events[0].start, data.events[0].attendances, data.events[0].responses], ["Autumn Open Day", "event", "2026-10-17 09:00:00", fx.OPEN_DAY_ATTENDANCES, 2]);
  assert.equal(data.complete, true);
  assert.equal(data.events[1].internal_title, "Spring open day - owner [email redacted]", "an email typed into an internal title is redacted");
  assert.deepEqual(data.events[0].tags, ["undergraduate", "campus"], "tags come back because event_rfields=tags asks for them");
  const past = await call(client, "list_events", { status: ["past"] });
  assert.equal(past.data.events[0].country, "United Kingdom (queries [email redacted])", "an email typed into the country is redacted");
  assert.ok(!past.text.includes("summer@"));
  const pastRaw = await call(client, "list_events", { status: ["past"], include_contact_details: true });
  assert.equal(pastRaw.data.events[0].country, "United Kingdom (queries summer@example.ac.uk)");
  const sessions = await call(client, "list_events", { parent_id: 2, status: ["future"] });
  assert.deepEqual(requests.at(-1).query, { status: "future", parent_id: "2", counts: "attendances,responses", event_rfields: "tags", page: "1", per_page: "50" }, "a single value is sent as it is");
  assert.deepEqual(sessions.data.events.map((e) => [e.id, e.type]), [[21, "session"], [22, "session"]]);
});

await check("get_event returns plain-text description with contact details redacted by default, sessions, location and categories", async () => {
  const { data, text } = await call(client, "get_event", { event_id: 2 });
  assert.deepEqual(requests.at(-1).query, { include: "children,location,categories", counts: "attendances,responses", event_rfields: "tags" });
  const e = data.event;
  assert.equal(e.description, "Autumn Open Day\nTours, talks & lunch.\nQuestions? Email [email redacted] or call [phone redacted].");
  assert.deepEqual(e.sessions.map((s) => [s.id, s.title, s.type]), [[21, "Campus tour (morning)", "session"], [22, "Subject talk: Computing", "session"]]);
  assert.equal(e.location.title, "Main Campus");
  assert.deepEqual(e.categories, [{ id: 2, title: "Open days" }]);
  assert.deepEqual(e.tags, ["undergraduate", "campus"]);
  assert.ok(!text.includes("admissions@") && !text.includes("496 0000"));
  const raw = await call(client, "get_event", { event_id: 2, include_contact_details: true });
  assert.match(raw.data.event.description, /admissions@example\.ac\.uk or call 0117 496 0000/);
});

await check("list_attendances pages 1, 2, 3 to the documented last_page, counts statuses, and shows names only", async () => {
  const n = requests.length;
  const { data, text } = await call(client, "list_attendances", { event_id: 2 });
  assert.deepEqual(since(n).map((r) => [r.path, r.query.page, r.query.per_page, r.query.event_id, r.query.include]), [1, 2, 3].map((p) => ["/attendances", String(p), "50", "2", "contact,event"]), "stops at last_page 3");
  const [p1, p2, p3] = since(n).map((r) => r.t);
  assert.ok(p2 - p1 >= 235 && p3 - p2 >= 235, `requests are spaced about 250 ms apart (gaps ${p2 - p1} and ${p3 - p2} ms)`);
  assert.deepEqual([data.count, data.total, data.last_page, data.complete, data.next_page], [fx.OPEN_DAY_ATTENDANCES, fx.OPEN_DAY_ATTENDANCES, 3, true, undefined]);
  assert.deepEqual(data.by_status_in_this_result, { Registered: 13, Attended: 7, Waitlisted: 1, Cancelled: 5 });
  const priya = data.attendances[0];
  assert.deepEqual([priya.contact_id, priya.name, priya.status, priya.status_code, priya.guest_count, priya.event.title], [11, "Priya Shah", "Registered", 10, 1, "Autumn Open Day"]);
  assert.equal(priya.email, undefined);
  assert.equal(data.attendances[2].name, "Lee Chen (call [phone redacted])", "a phone number typed into a name is redacted");
  for (const leak of ["@example.com", "pay.example.test", "01TESTPAYMENT", "completed", "rsvp", "ical", "passbook", "video", "qr.example", "07700"]) assert.ok(!text.includes(leak), `${leak} leaked`);
  const withContact = await call(client, "list_attendances", { event_id: 2, include_contact_details: true, max_pages: 1 });
  assert.equal(withContact.data.attendances[0].email, "priya.shah@example.com");
  assert.equal(withContact.data.attendances[2].name, "Lee Chen (call 07700 900456)");
  for (const leak of ["pay.example.test", "01TESTPAYMENT", "rsvp", "ical", "passbook", "video", "qr.example"]) assert.ok(!withContact.text.includes(leak), `${leak} returned even with include_contact_details`);
});

await check("list_attendances stops at max_pages and continues from next_page", async () => {
  const first = await call(client, "list_attendances", { event_id: 2, max_pages: 1 });
  assert.deepEqual([first.data.count, first.data.complete, first.data.next_page], [10, false, 2]);
  assert.match(first.data.note, /page 2 and per_page 50/);
  const next = await call(client, "list_attendances", { event_id: 2, page: 2, max_pages: 1 });
  assert.equal(requests.at(-1).query.page, "2");
  assert.equal(next.data.attendances[0].id, fx.attendances[10].id);
  const n = requests.length;
  const capped = await call(client, "search_contacts", { keyword: "student", per_page: 5 });
  assert.deepEqual(since(n).map((r) => r.body.page), [1, 2, 3, 4], "max_pages defaults to 4");
  assert.deepEqual([capped.data.count, capped.data.total, capped.data.complete, capped.data.next_page], [20, 23, false, 5]);
});

await check("list_attendances by contact passes contact_id and the status codes as documented; neither id is refused locally", async () => {
  const { data } = await call(client, "list_attendances", { contact_id: fx.PRIYA, statuses: ["attended", "did_not_attend"] });
  assert.deepEqual(requests.at(-1).query, { contact_id: "11", status: "@30|100", include: "contact,event", page: "1", per_page: "50" });
  assert.deepEqual(data.attendances.map((a) => [a.event_id, a.event.title, a.status]), [[4, "Online Q&A: Student Finance", "Attended"], [5, "Summer Open Day 2026", "Did not attend"]]);
  const n = requests.length;
  const none = await call(client, "list_attendances", {});
  assert.ok(none.res.isError);
  assert.match(none.text, /Give an event_id, a contact_id, or both/);
  assert.equal(requests.length, n);
});

await check("list_forms (after a 429 retry that waits for Retry-After) passes module, published and group and returns response counts", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_forms", { modules: ["form", "event"], published: true });
  const tries = since(n).filter((r) => r.path === "/forms");
  assert.equal(tries.length, 2, "forms should be retried once after 429");
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1000 && gap < 1900, `retry should wait the Retry-After of 1 s, not the 2 s fallback (waited ${gap} ms)`);
  assert.deepEqual(tries[1].query, { module: "@form|event", published: "1", counts: "responses", page: "1", per_page: "50" });
  assert.deepEqual(data.forms.map((f) => [f.id, f.name, f.module, f.published, f.responses]), [[31, "Open Day Registration", "event", true, 2], [32, "Undergraduate Enquiry", "form", true, 2]]);
  assert.equal(data.forms[1].group, "Enquiries (owner [email redacted] [phone redacted])", "contact details typed into a form group are redacted");
  const all = await call(client, "list_forms");
  for (const leak of ["jo.bloggs", "07700", "@example"]) assert.ok(!all.text.includes(leak), `${leak} leaked from list_forms with default arguments`);
  const grouped = await call(client, "list_forms", { group: "Applications", published: false });
  assert.deepEqual([requests.at(-1).query.group, requests.at(-1).query.published], ["Applications", "0"]);
  assert.deepEqual(grouped.data.forms.map((f) => [f.id, f.name]), [[33, "Scholarship Application (queries: [email redacted])"]], "form names are always redacted");
});

await check("list_form_responses passes form_id, label and response_keyword; the response email only on request", async () => {
  const { data, text } = await call(client, "list_form_responses", { form_ids: [31, 32], label_ids: [1, 2], keyword: "example.com" });
  assert.deepEqual(requests.at(-1).query, { form_id: "@31|32", label: "@1|2", response_keyword: "example.com", include: "labels", response_rfields: "label_ids", page: "1", per_page: "50" });
  assert.deepEqual(data.responses.map((r) => [r.id, r.form_id, r.contact_id, r.status, r.labels, r.label_ids]), [[301, 31, 11, "completed", ["Open day 2026"], [2]], [303, 32, 13, "completed", ["Prospect"], [1]]]);
  assert.ok(!text.includes("@example.com"));
  // Documented default: responses to application-module forms (form 33) are left out unless module=application.
  const excluded = await call(client, "list_form_responses", { form_ids: [33] });
  assert.equal(requests.at(-1).query.module, undefined);
  assert.deepEqual([excluded.data.count, excluded.data.complete], [0, true], "without module, the application form's responses are excluded");
  const withEmail = await call(client, "list_form_responses", { form_ids: [33], module: "application", include_contact_details: true });
  assert.deepEqual(requests.at(-1).query, { form_id: "33", module: "application", include: "labels", response_rfields: "label_ids", page: "1", per_page: "50" });
  assert.deepEqual(withEmail.data.responses.map((r) => [r.id, r.status, r.email]), [[304, "draft", "priya.shah@example.com"]]);
  const events = await call(client, "list_form_responses", { module: "event" });
  assert.deepEqual(events.data.responses.map((r) => r.id), [301, 302], "module restricts to one module");
});

await check("search_contacts pages through POST /contacts/search bodies that validate against the documented request schema", async () => {
  const n = requests.length;
  const { data, text } = await call(client, "search_contacts", { keyword: "student" });
  const posts = since(n);
  assert.deepEqual(posts.map((r) => [r.method, r.path, r.body.page, r.body.per_page]), [1, 2, 3].map((p) => ["POST", "/contacts/search", p, 50]));
  for (const r of posts) validateBody("POST", "/contacts/search", r.body, "search body");
  assert.deepEqual(posts[0].body, { page: 1, per_page: 50, include: "labels", keyword: "student" });
  assert.deepEqual([data.count, data.total, data.complete], [23, 23, true]);
  assert.deepEqual(data.contacts[1], { id: 101, contact_ulid: "01TESTCONTACT0000000000101", name: "Student 2", preferred_language: "en", responses: 1, labels: [{ id: 2, name: "Open day 2026" }] });
  for (const leak of ["@example.com", "portal.example", "qr.example", "events.example", "st**@"]) assert.ok(!text.includes(leak), `${leak} leaked`);
  const m = requests.length;
  const byLabel = await call(client, "search_contacts", { label_ids: [1, 2], attendance_event_id: 2 });
  assert.deepEqual(since(m).map((r) => r.body), [1, 2].map((page) => ({ page, per_page: 50, include: "labels", label: "@1|2", attendance_event_id: 2 })), "the filters are repeated on every page");
  assert.equal(byLabel.data.total, 13);
  assert.deepEqual(byLabel.data.contacts.slice(0, 2).map((c) => c.name), ["Priya Shah", "Sam Evans"]);
  const byEmail = await call(client, "search_contacts", { email: "priya.shah@example.com", include_contact_details: true });
  assert.equal(requests.at(-1).body.email, "priya.shah@example.com");
  assert.deepEqual(byEmail.data.contacts.map((c) => [c.id, c.email]), [[11, "priya.shah@example.com"]]);
  const lee = await call(client, "search_contacts", { keyword: "lee" });
  assert.equal(lee.data.contacts[0].name, "Lee Chen (call [phone redacted])");
});

await check("get_contact by id or ULID returns name, labels and counts only by default, without fetching contact fields", async () => {
  const { data, text } = await call(client, "get_contact", { contact_id: String(fx.PRIYA) });
  assert.deepEqual(requests.at(-1).query, { include: "labels", counts: "attendances,responses" });
  const c = data.contact;
  assert.deepEqual([c.id, c.contact_ulid, c.name, c.attendances, c.responses_count], [11, fx.PRIYA_ULID, "Priya Shah", 3, 2]);
  assert.deepEqual(c.labels.map((l) => l.name), ["Prospect", "Open day 2026"]);
  assert.equal(c.fields, undefined);
  for (const leak of ["@example.com", "07700", "2009-04-02", "Example Academy", "BS1", "portal.example", "qr.example", "events.example", "st**@"]) assert.ok(!text.includes(leak), `${leak} leaked`);
  const byUlid = await call(client, "get_contact", { contact_id: fx.PRIYA_ULID });
  assert.equal(requests.at(-1).path, `/contacts/${fx.PRIYA_ULID}`);
  assert.equal(byUlid.data.contact.id, 11);
});

await check("get_contact with include_contact_details returns every contact field except bank and card data", async () => {
  const { data, text } = await call(client, "get_contact", { contact_id: String(fx.PRIYA), include_contact_details: true });
  assert.deepEqual(requests.at(-1).query, { include: "labels,current_values.field", counts: "attendances,responses" });
  const c = data.contact;
  assert.equal(c.email, "priya.shah@example.com");
  assert.deepEqual(c.fields.map((f) => [f.label, f.value]), [["Email", "priya.shah@example.com"], ["Mobile number", "07700 900123"], ["Date of birth", "2009-04-02"], ["Current school", "Example Academy, Bristol"], ["Home postcode", "BS1 4ST"], ["Preferred Language", "en"]]);
  assert.equal(c.fields[2].sensitive, true);
  assert.equal(c.financial_fields_never_returned, 2);
  for (const leak of [fx.BANK_VALUE, fx.CARD_VALUE, "Bank account", "Card number", "portal.example", "qr.example"]) assert.ok(!text.includes(leak), `${leak} returned`);
});

await check("list_labels, list_campaigns and get_campaign_stats pass their documented parameters", async () => {
  const labels = await call(client, "list_labels", { keyword: "open" });
  assert.deepEqual(requests.at(-1).query, { keyword: "open", page: "1", per_page: "50" });
  assert.deepEqual(labels.data.labels, [{ id: 2, name: "Open day 2026", color: "#00AA55", ai_generated: false }]);
  const callBack = await call(client, "list_labels", { keyword: "call" });
  assert.deepEqual(callBack.data.labels.map((l) => l.name), ["Call back ([phone redacted])"], "label names are always redacted");
  const campaigns = await call(client, "list_campaigns", { statuses: ["active", "complete"], modules: ["whatsapp", "call"] });
  assert.deepEqual(requests.at(-1).query, { status: "@20|30", module: "@whatsapp|call", counts: "subscribers", page: "1", per_page: "50" });
  assert.deepEqual(campaigns.data.campaigns.map((c) => [c.id, c.module, c.status, c.subscribers]), [[41, "whatsapp", "Complete", 120], [42, "call", "Active", 45]]);
  assert.equal(campaigns.data.campaigns[1].description, "Call offer holders; escalate to [phone redacted]");
  const clearing = await call(client, "list_campaigns", { keyword: "clearing" });
  assert.equal(clearing.data.campaigns[0].description, "Hotline [phone redacted], [phone redacted], [phone redacted] or [phone redacted]", "the +44 (0), bracketed, 00-prefixed and dot-separated forms are redacted");
  const stats = await call(client, "get_campaign_stats", { campaign_id: 41, from: "2026-09-01", to: "2026-09-07" });
  assert.equal(requests.at(-1).path, "/campaigns/41/stats");
  assert.deepEqual(requests.at(-1).query, { from: "2026-09-01 00:00:00", to: "2026-09-07 23:59:59", group: "daily" }, "the last day is sent with its end-of-day time");
  assert.deepEqual([stats.data.stats.range.from, stats.data.stats.range.to], ["2026-09-01T00:00:00+00:00", "2026-09-07T23:59:59+00:00"]);
  assert.deepEqual(stats.data.stats.summary, { total_messages: 4, attempted: 4, delivered: 2, read: 1, open_rate_percent: 50, delivery_rate_percent: 50 });
  assert.deepEqual(stats.data.stats.periods.map((p) => [p.period, p.delivered, p.failed]), [["2026-09-01", 2, 0], ["2026-09-07", 0, 1]]);
  const n = requests.length;
  for (const args of [{ campaign_id: 41, from: "2026-02-30", to: "2026-03-01" }, { campaign_id: 41, from: "2026-09-07", to: "2026-09-01" }, { campaign_id: 41, from: "1/9/2026", to: "2026-09-07" }]) {
    const bad = await call(client, "get_campaign_stats", args);
    assert.ok(bad.res.isError, JSON.stringify(args));
  }
  assert.equal(requests.length, n, "impossible dates and reversed ranges are refused before any request");
});

await check("register_contact_for_event checks for an existing booking, then posts a body that validates against the documented request schema", async () => {
  const n = requests.length;
  const { data } = await call(client, "register_contact_for_event", { contact_id: 12, event_id: 3 });
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), ["GET /attendances", "POST /attendances"]);
  assert.deepEqual(since(n)[0].query, { contact_id: "12", event_id: "3", trashed: "1", page: "1", per_page: "1" });
  const post = requests.at(-1);
  validateBody("POST", "/attendances", post.body, "POST /attendances body");
  assert.deepEqual(post.body, { contact_id: 12, event_id: 3, status: "yes" });
  assert.deepEqual([data.result, data.attendance.status, data.attendance.contact_id, data.attendance.event_id], ["registered", "Registered", 12, 3]);
  const wait = await call(client, "register_contact_for_event", { contact_id: 13, event_id: 3, waitlist: true, guest_count: 1 });
  validateBody("POST", "/attendances", requests.at(-1).body, "POST /attendances waitlist body");
  assert.deepEqual(requests.at(-1).body, { contact_id: 13, event_id: 3, status: "waitlist", guest_count: 1 });
  assert.deepEqual([wait.data.result, wait.data.attendance.status, wait.data.attendance.guest_count], ["added to the waitlist", "Waitlisted", 1]);
  const m = requests.length;
  const again = await call(client, "register_contact_for_event", { contact_id: fx.PRIYA, event_id: 2 });
  assert.ok(again.res.isError);
  assert.match(again.text, /Not registered: contact 11 already has an attendance on event 2 \(attendance \d+, status Registered\)/);
  assert.deepEqual(since(m).map((r) => r.method), ["GET"], "no POST for an existing booking");
  const k = requests.length;
  const deleted = await call(client, "register_contact_for_event", { contact_id: 12, event_id: 4 });
  assert.ok(deleted.res.isError);
  assert.match(deleted.text, /Not registered: contact 12 already has an attendance on event 4 \(attendance \d+, status Cancelled\)\. This tool only creates new bookings, and the check includes deleted attendances\./);
  assert.deepEqual(since(k).map((r) => r.method), ["GET"], "no POST when the only attendance is a soft-deleted one");
});

await check("add_contact_label keeps existing labels in a replace_labels body that validates against the spec, and does nothing when already labelled", async () => {
  const n = requests.length;
  const { data } = await call(client, "add_contact_label", { contact_id: 12, label_id: 3 });
  assert.deepEqual(since(n).map((r) => `${r.method} ${r.path}`), ["GET /labels", "GET /contacts/12", "POST /contacts/12/replace_labels"]);
  assert.deepEqual(since(n)[0].query, { id: "3", page: "1", per_page: "1" });
  const post = requests.at(-1);
  validateBody("POST", "/contacts/{id}/replace_labels", post.body, "replace_labels body");
  assert.deepEqual(post.body, { labels: [1, 3], include: "labels" });
  assert.equal(data.result, 'label "Scholarship interest" added');
  assert.deepEqual(data.contact.labels.map((l) => l.name), ["Prospect", "Scholarship interest"]);
  const m = requests.length;
  const again = await call(client, "add_contact_label", { contact_id: 12, label_id: 3 });
  assert.match(again.data.result, /unchanged/);
  assert.deepEqual(since(m).map((r) => r.method), ["GET", "GET"]);
  const k = requests.length;
  const unknown = await call(client, "add_contact_label", { contact_id: 12, label_id: 99 });
  assert.ok(unknown.res.isError);
  assert.match(unknown.text, /Label 99 does not exist/);
  assert.deepEqual(since(k).map((r) => r.path), ["/labels"]);
});

await check("bad IDs are rejected before any API call; unknown IDs give a clear 404; a 403 points to whoami", async () => {
  const before = requests.length;
  for (const [tool, args] of [
    ["get_event", { event_id: -1 }],
    ["get_event", { event_id: 1.5 }],
    ["get_event", { event_id: "2" }],
    ["get_contact", { contact_id: "../contacts" }],
    ["get_contact", { contact_id: "abc" }],
    ["list_attendances", { event_id: 0 }],
    ["register_contact_for_event", { contact_id: 12, event_id: "3/x" }],
    ["add_contact_label", { contact_id: 12.5, label_id: 1 }],
    ["list_labels", { per_page: 101 }],
    ["list_labels", { max_pages: 21 }],
    ["list_labels", { keyword: "   " }],
    ["search_contacts", { email: " " }],
    ["list_forms", { group: "@Applications|Events" }],
    ["list_form_responses", { module: "@application|form" }],
  ]) {
    const bad = await client.callTool({ name: tool, arguments: args });
    assert.ok(bad.isError, `${tool} should reject ${JSON.stringify(args)}`);
  }
  assert.equal(requests.length, before, "no request for invalid IDs, blank keywords or a group that would be read as several");
  await call(client, "list_labels", { keyword: "  open " });
  assert.equal(requests.at(-1).query.keyword, "open", "keywords are trimmed");
  const missing = await call(client, "get_event", { event_id: 999 });
  assert.ok(missing.res.isError);
  assert.equal(missing.text, "Not found: /events/999. Check the ID. The event you requested is not available.");
  const missingContact = await call(client, "get_contact", { contact_id: "999" });
  assert.match(missingContact.text, /Not found: \/contacts\/999\. Check the ID\. The contact you requested is not available\./);
  arm({ method: "GET", path: "/events/3", status: 403, body: { message: "You do not have permission to perform this action." } });
  const forbidden = await call(client, "get_event", { event_id: 3 });
  assert.match(forbidden.text, /Gecko refused GET \/events\/3 \(403\).*Call whoami.*You do not have permission to perform this action\./);
  disarm();
});

await check("a persistent 429 gives up after 3 attempts; a Retry-After above the cap gives up at once; no Retry-After waits 2 s then 4 s", async () => {
  arm({ method: "GET", path: "/labels", status: 429, times: 3, headers: { "Retry-After": "0" }, body: { message: "Too Many Attempts." } });
  let n = requests.length;
  const limited = await call(client, "list_labels");
  assert.ok(limited.res.isError);
  assert.equal(since(n).length, 3, "exactly three attempts");
  assert.match(limited.text, /Gecko rate limit reached \(the limit is not documented\)\. Wait a minute and try again\. Too Many Attempts\./);
  disarm();
  arm({ method: "GET", path: "/labels", status: 429, headers: { "Retry-After": "600" }, body: { message: "Too Many Attempts." } });
  n = requests.length;
  const long = await call(client, "list_labels");
  assert.equal(since(n).length, 1);
  assert.match(long.text, /asked to wait 600 seconds before retrying GET \/labels \(HTTP 429\)/);
  disarm();
  arm({ method: "GET", path: "/labels", status: 429, times: 2, body: { message: "Too Many Attempts." } });
  n = requests.length;
  assert.ok(!(await call(client, "list_labels")).res.isError);
  const [a, b, c] = since(n).map((r) => r.t);
  assert.ok(since(n).length === 3 && b - a >= 2000 && b - a < 3200 && c - b >= 4000 && c - b < 5200, `without Retry-After the retries wait 2 s then 4 s (waited ${b - a} and ${c - b} ms)`);
  disarm();
});

await check("an HTTP-date Retry-After and a fractional one are honoured", async () => {
  // HTTP-dates have 1 s resolution, so aim at a whole second 4 to 5 s ahead: after the first request's
  // round trip the wait is 3.5 to 5 s, clearly apart from both "retry at once" and the 2 s fallback.
  arm({ method: "GET", path: "/labels", status: 429, headers: { "Retry-After": new Date(Math.ceil((Date.now() + 4000) / 1000) * 1000).toUTCString() }, body: { message: "Too Many Attempts." } });
  let n = requests.length;
  assert.ok(!(await call(client, "list_labels")).res.isError);
  let tries = since(n);
  let gap = tries[1].t - tries[0].t;
  assert.ok(tries.length === 2 && gap >= 3000 && gap < 5600, `retry should wait until the given date (waited ${gap} ms)`);
  disarm();
  arm({ method: "GET", path: "/labels", status: 429, headers: { "Retry-After": "1.5" }, body: { message: "Too Many Attempts." } });
  n = requests.length;
  assert.ok(!(await call(client, "list_labels")).res.isError);
  tries = since(n);
  gap = tries[1].t - tries[0].t;
  assert.ok(tries.length === 2 && gap >= 1400 && gap < 1900, `retry should wait 1.5 s (waited ${gap} ms)`);
  disarm();
});

await check("a Retry-After of exactly the 10 s cap is waited; an empty page ends a list even when last_page says more", async () => {
  arm({ method: "GET", path: "/labels", status: 429, headers: { "Retry-After": "10" }, body: { message: "Too Many Attempts." } });
  let n = requests.length;
  assert.ok(!(await call(client, "list_labels")).res.isError);
  const tries = since(n);
  const gap = tries[1].t - tries[0].t;
  assert.ok(tries.length === 2 && gap >= 9900 && gap < 10900, `a Retry-After equal to the cap is honoured (waited ${gap} ms)`);
  disarm();
  arm({ method: "GET", path: "/labels", status: 200, body: { current_page: 1, data: [], from: null, last_page: 5, per_page: 50, to: null, total: 0 } });
  n = requests.length;
  const empty = await call(client, "list_labels");
  assert.equal(since(n).length, 1, "no second request after an empty page");
  assert.deepEqual([empty.data.count, empty.data.complete, empty.data.next_page], [0, true, undefined]);
  disarm();
});

await check("502 on a GET is retried; three 503s give advice without the gateway HTML; a gateway error on POST is never retried", async () => {
  arm({ method: "GET", path: "/labels", status: 502, headers: { "Retry-After": "0" } });
  let n = requests.length;
  assert.ok(!(await call(client, "list_labels")).res.isError);
  assert.equal(since(n).length, 2);
  disarm();
  arm({ method: "GET", path: "/labels", status: 503, times: 3, headers: { "Retry-After": "0" } });
  n = requests.length;
  const down = await call(client, "list_labels");
  assert.equal(since(n).length, 3);
  assert.equal(down.text, "Gecko returned 503 for GET /labels 3 times in a row. The service may be unavailable; try again in a few minutes.");
  disarm();
  arm({ method: "POST", path: "/attendances", status: 502, headers: { "Retry-After": "0" } });
  n = requests.length;
  const post = await call(client, "register_contact_for_event", { contact_id: 100, event_id: 3 });
  assert.ok(post.res.isError);
  assert.equal(since(n).filter((r) => r.method === "POST").length, 1, "exactly one POST");
  assert.match(post.text, /Gecko returned 502 for POST \/attendances\. The request was not retried because it may already have been processed: check with the matching list or get tool/);
  assert.ok(!post.text.includes("<html>") && !post.text.includes("admissions@"));
  disarm();
  arm({ method: "POST", path: "/attendances", status: 429, headers: { "Retry-After": "0" }, body: { message: "Too Many Attempts." } });
  n = requests.length;
  const retried = await call(client, "register_contact_for_event", { contact_id: 101, event_id: 3 });
  assert.ok(!retried.res.isError, retried.text);
  assert.equal(since(n).filter((r) => r.method === "POST").length, 2, "a 429 on POST is retried once (a rate-limited request is assumed not processed)");
  disarm();
});

await check("a 200 that is not JSON is an error; error messages are redacted and never carry a token", async () => {
  arm({ method: "GET", path: "/labels", status: 200, body: "<html>login page for admissions@example.ac.uk</html>" });
  const html = await call(client, "list_labels");
  assert.ok(html.res.isError);
  assert.match(html.text, /returned 200 for GET \/labels but the body was not JSON \(\d+ bytes\)\. Check GECKO_BASE_URL/);
  assert.ok(!html.text.includes("admissions@") && !html.text.includes("login page for"));
  disarm();
  arm({ method: "POST", path: "/attendances", status: 400, body: ({ bearer }) => ({ message: `Token ${bearer} cannot book priya.shah@example.com (07700 900123).` }) });
  const echoed = await call(client, "register_contact_for_event", { contact_id: 102, event_id: 3 });
  assert.equal(echoed.text, "Gecko refused POST /attendances (400). Token [redacted] cannot book [email redacted] ([phone redacted]).");
  disarm();
  arm({ method: "GET", path: "/labels", status: 422, body: { messages: { keyword: ["The keyword is too long."] } } });
  assert.equal((await call(client, "list_labels", { keyword: "x" })).text, "Gecko refused GET /labels (422). keyword: The keyword is too long.");
  disarm();
  arm({ method: "GET", path: "/labels", status: 500, body: { success: false, errors: [{ code: 7, title: "Server error", detail: "Contact support at help@example.ac.uk" }] } });
  const structured = await call(client, "list_labels");
  assert.equal(structured.text, "Gecko returned 500 for GET /labels. Server error: Contact support at [email redacted] (code 7)");
  disarm();
  arm({ method: "GET", path: "/labels", status: 404, body: { message: "Not here.", details: "Ask 07700 900999." } });
  assert.equal((await call(client, "list_labels")).text, "Not found: /labels. Check the ID. Not here. Ask [phone redacted].");
  disarm();
});
await client.close();

console.log("tokens");
const byToken = (n) => since(n).map((r) => (r.path === TOKEN_PATH ? "refresh" : `${r.method} ${r.path}`));

await check("an Access token about to expire is refreshed with the Refresh token before the call, and the new tokens are reused", async () => {
  const t = issue({ accessTtl: 30 });
  const log = [];
  const c = await connect({ access: t.access, refresh: t.refresh, stderr: log });
  const n = requests.length;
  assert.ok(!(await call(c, "list_labels")).res.isError);
  assert.match(log.join(""), /Gecko tokens refreshed\. The refresh token in GECKO_REFRESH_TOKEN has now been used and will not work again\. The new tokens are kept in memory only: after a restart, create a new API token/);
  assert.ok(!log.join("").includes(t.refresh), "the log never shows a token");
  assert.ok(!(await call(c, "list_forms")).res.isError);
  assert.deepEqual(byToken(n), ["refresh", "GET /labels", "GET /forms"], "one refresh, then both calls");
  const [refreshReq, labelsReq] = since(n);
  assert.equal(refreshReq.method, "GET");
  assert.equal(refreshReq.auth, `Bearer ${t.refresh}`, "the refresh call authenticates with the Refresh token");
  assert.notEqual(labelsReq.bearer, t.access, "the API call uses the new Access token");
  assert.ok(mock.issuedAccess.has(labelsReq.bearer));
  assert.equal(mock.refreshValid(t.refresh), false, "the old Refresh token is spent");
  const who = await call(c, "whoami");
  assert.equal(who.data.token.refresh_token_configured, true);
  assert.ok(new Date(who.data.token.access_token_expires).getTime() > Date.now() + 3600_000, "the reported expiry is the new token's");
  // An error that echoes a token issued by the refresh is scrubbed too, not only the ones from the env.
  const rotated = mock.issued.at(-1);
  assert.equal(labelsReq.bearer, rotated.access);
  arm({ method: "GET", path: "/labels", status: 400, body: ({ bearer }) => ({ message: `bad token ${bearer}`, details: `refresh ${rotated.refresh} id ${rotated.id}` }) });
  const echo = await call(c, "list_labels");
  assert.equal(echo.text, "Gecko refused GET /labels (400). bad token [redacted] refresh [redacted] id [redacted]");
  for (const secret of [rotated.access, rotated.refresh, rotated.id]) assert.ok(!echo.text.includes(secret), "a rotated token leaked into an error message");
  disarm();
  await c.close();
  // The same (now spent) tokens after a "restart": the refresh is refused with instructions.
  const restarted = await connect({ access: t.access, refresh: t.refresh });
  const m = requests.length;
  const r = await call(restarted, "list_labels");
  assert.ok(r.res.isError);
  assert.deepEqual(byToken(m), ["refresh"], "no API call with an unusable token");
  assert.match(r.text, /Gecko rejected the refresh token at http:\/\/127\.0\.0\.1:\d+\/tokens\/refresh \(401\)\. Refresh tokens can only be used once.*Create a new API token in Gecko under Security Preferences -> Active Sessions -> Create New API Token/);
  assert.ok(!r.text.includes(t.refresh) && !r.text.includes(t.access));
  await restarted.close();
});

await check("a rejected Access token is refreshed once and the call retried; concurrent calls share one refresh", async () => {
  const t = issue();
  const c = await connect({ access: t.access, refresh: t.refresh });
  assert.ok(!(await call(c, "list_labels")).res.isError);
  mock.revoke(t.access);
  let n = requests.length;
  const after = await call(c, "list_labels");
  assert.ok(!after.res.isError, after.text);
  assert.deepEqual(byToken(n), ["GET /labels", "refresh", "GET /labels"]);
  const firstRefresh = since(n).find((r) => r.path === TOKEN_PATH);
  assert.equal(firstRefresh.bearer, t.refresh);
  const rotated = mock.issued.at(-1);
  assert.equal(requests.at(-1).bearer, rotated.access, "the retry uses the new Access token");
  assert.equal(mock.refreshValid(rotated.refresh), true, "the rotated Refresh token is not used yet");
  // A second rejection on the same server: the refresh must use the rotated Refresh token, not the
  // spent one from GECKO_REFRESH_TOKEN (which would fail, about a day after start in real use).
  mock.revoke(rotated.access);
  n = requests.length;
  const again = await call(c, "list_labels");
  assert.ok(!again.res.isError, again.text);
  assert.deepEqual(byToken(n), ["GET /labels", "refresh", "GET /labels"]);
  const secondRefresh = since(n).find((r) => r.path === TOKEN_PATH);
  assert.notEqual(secondRefresh.bearer, t.refresh, "the spent Refresh token is not used again");
  assert.equal(secondRefresh.bearer, rotated.refresh, "the second refresh uses the Refresh token the first one returned");
  assert.equal(mock.refreshValid(rotated.refresh), false, "the rotated Refresh token is spent by the second refresh");
  assert.equal(requests.at(-1).bearer, mock.issued.at(-1).access);
  await c.close();
  const u = issue({ accessTtl: 30 });
  const c2 = await connect({ access: u.access, refresh: u.refresh });
  n = requests.length;
  const results = await Promise.all([call(c2, "list_labels"), call(c2, "list_forms"), call(c2, "whoami")]);
  for (const r of results) assert.ok(!r.res.isError, r.text);
  assert.equal(since(n).filter((r) => r.path === TOKEN_PATH).length, 1, "one refresh for three concurrent calls (a second would fail: refresh tokens are single-use)");
  await c2.close();
});

await check("a 401 that persists after a refresh is reported after exactly one refresh (no loop spending Refresh tokens)", async () => {
  const t = issue();
  const c = await connect({ access: t.access, refresh: t.refresh });
  arm({ method: "GET", path: "/labels", status: 401, times: 2, body: { message: "Please authenticate to access this endpoint.", details: null } });
  const n = requests.length;
  const r = await call(c, "list_labels");
  assert.ok(r.res.isError);
  assert.deepEqual(byToken(n), ["GET /labels", "refresh", "GET /labels"]);
  assert.match(r.text, /^Gecko rejected the Access token \(401\) for GET \/labels, even after refreshing it\. Check GECKO_ACCESS_TOKEN and GECKO_REFRESH_TOKEN.*Please authenticate to access this endpoint\.$/);
  disarm();
  await c.close();
});

await check("a 429 from the refresh endpoint is retried (a rate-limited refresh was not processed)", async () => {
  const t = issue({ accessTtl: 30 });
  const c = await connect({ access: t.access, refresh: t.refresh });
  arm({ method: "GET", path: TOKEN_PATH, status: 429, headers: { "Retry-After": "0" }, body: { message: "Too Many Attempts." } });
  const n = requests.length;
  const r = await call(c, "list_labels");
  assert.ok(!r.res.isError, r.text);
  assert.deepEqual(byToken(n), ["refresh", "refresh", "GET /labels"]);
  assert.ok(since(n).slice(0, 2).every((x) => x.bearer === t.refresh), "the retry sends the same, still unused, Refresh token");
  disarm();
  await c.close();
});

await check("an expired Access token without a Refresh token, an expired Refresh token, or a wrong Access token gives an actionable message", async () => {
  const expired = issue({ accessTtl: -10 });
  const c = await connect({ access: expired.access });
  let n = requests.length;
  const r = await call(c, "list_labels");
  assert.match(r.text, /The Gecko Access token expired at \d{4}-\d\d-\d\dT.*and no GECKO_REFRESH_TOKEN is set\. Create a new API token/);
  assert.equal(requests.length, n, "no request with a token known to be expired");
  await c.close();
  const stale = issue({ accessTtl: 30, refreshTtl: -5 });
  const s = await connect({ access: stale.access, refresh: stale.refresh });
  n = requests.length;
  const rs = await call(s, "list_labels");
  assert.match(rs.text, /The Gecko Refresh token expired at \d{4}-.*\(they last about 30 days\)\. Create a new API token/);
  assert.equal(requests.length, n, "no request with a Refresh token known to be expired");
  await s.close();
  const wrong = jwt({ region: "eu", exp: Math.floor(Date.now() / 1000) + 3600, jti: "gecko-wrong-token-not-real" });
  const w = await connect({ access: `Bearer ${wrong}` });
  n = requests.length;
  const rw = await call(w, "list_labels");
  assert.equal(since(n).length, 1);
  assert.equal(since(n)[0].auth, `Bearer ${wrong}`, "a token pasted with its Bearer prefix is sent once");
  assert.match(rw.text, /Gecko rejected the Access token \(401\) for GET \/labels\. Check GECKO_ACCESS_TOKEN \(and set GECKO_REFRESH_TOKEN so it can be renewed\).*Please authenticate to access this endpoint\./);
  await w.close();
});

await check("a gateway error from the refresh endpoint is not retried (the Refresh token is single-use)", async () => {
  const t = issue({ accessTtl: 30 });
  const c = await connect({ access: t.access, refresh: t.refresh });
  arm({ method: "GET", path: TOKEN_PATH, status: 502, headers: { "Retry-After": "0" } });
  const n = requests.length;
  const r = await call(c, "list_labels");
  assert.deepEqual(byToken(n), ["refresh"]);
  assert.match(r.text, /Gecko returned 502 for the token refresh at .*It was not retried, because refresh tokens are single-use/);
  disarm();
  await c.close();
});

await check("the API host comes from the Access token's region claim; a missing or unknown region, an unreadable token, no token or credentials in a URL stop the server at start-up", async () => {
  const { regionBaseUrl } = await import(pathToFileURL(`${root}dist/client.js`).href);
  assert.equal(regionBaseUrl(jwt({ region: "eu" })), "https://api-eu.geckoform.com");
  assert.equal(regionBaseUrl(jwt({ region: "us-e" })), "https://api-us-e.geckoform.com");
  assert.equal(regionBaseUrl(jwt({ region: "ca" })), "https://api-ca.geckoform.com");
  assert.throws(() => regionBaseUrl(jwt({ exp: 1 })), /region claim is missing/);
  const n = requests.length;
  for (const [token, message] of [
    [jwt({ region: "xx", exp: Math.floor(Date.now() / 1000) + 600 }), /region claim is "xx"; the documented regions are eu, us-e and ca\. Set GECKO_BASE_URL/],
    ["not-a-jwt-test-value", /not a readable JWT/],
  ]) {
    const env = { ...process.env, GECKO_ACCESS_TOKEN: token };
    delete env.GECKO_BASE_URL;
    const run = spawnSync(process.execPath, [`${root}dist/index.js`], { env, input: "", encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 1);
    assert.match(run.stderr, message);
  }
  for (const [variable, value] of [["GECKO_BASE_URL", `http://${["user", "not-real"].join(":")}@127.0.0.1:1`], ["GECKO_TOKEN_URL", `http://${["user", "not-real"].join(":")}@127.0.0.1:1/tokens/refresh`]]) {
    const run = spawnSync(process.execPath, [`${root}dist/index.js`], { env: { PATH: process.env.PATH, GECKO_ACCESS_TOKEN: jwt({ region: "eu" }), [variable]: value }, input: "", encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 1);
    assert.match(run.stderr, new RegExp(`${variable} must not contain a username or password`));
    assert.ok(!run.stderr.includes("secret-test"), "the password is not repeated");
  }
  const noToken = spawnSync(process.execPath, [`${root}dist/index.js`], { env: { PATH: process.env.PATH }, input: "", encoding: "utf8", timeout: 10000 });
  assert.equal(noToken.status, 1);
  assert.match(noToken.stderr, /GECKO_ACCESS_TOKEN is not set/);
  assert.equal(requests.length, n, "no request was made");
});

await check("writes are off when GECKO_ALLOW_WRITES is unset, and when it is 'false'", async () => {
  for (const value of [null, "false"]) {
    const t = issue();
    const ro = await connect({ access: t.access, refresh: t.refresh, writes: value });
    const { tools } = await ro.listTools();
    assert.deepEqual(tools.filter((t) => WRITES.includes(t.name)), [], `writes exposed with GECKO_ALLOW_WRITES ${value === null ? "unset" : `= "${value}"`}`);
    assert.equal(tools.length, 11);
    await ro.close();
  }
});

await check("every request used a token the mock issued, a documented method and path and documented query parameters; the only POSTs are search and the two writes", async () => {
  const templates = Object.entries(spec.paths).flatMap(([p, ops]) =>
    Object.keys(ops).filter((m) => m !== "parameters").map((m) => ({ m: m.toUpperCase(), p, re: new RegExp("^" + p.replace(/\{[^}]+\}/g, "[^/]+") + "$") })),
  );
  assert.ok(requests.length > 60);
  const deliberatelyWrong = new Set(requests.filter((r) => r.bearer && JSON.parse(Buffer.from(r.bearer.split(".")[1], "base64url")).jti === "gecko-wrong-token-not-real").map((r) => r.bearer));
  assert.equal(deliberatelyWrong.size, 1);
  const used = new Set();
  for (const r of requests) {
    if (r.path === TOKEN_PATH) {
      assert.equal(r.method, "GET");
      assert.equal(JSON.parse(Buffer.from(r.bearer.split(".")[1], "base64url")).token_use, "refresh", "the refresh call carries a Refresh token");
      continue;
    }
    assert.ok(mock.issuedAccess.has(r.bearer) || deliberatelyWrong.has(r.bearer), `${r.method} ${r.path} used a token the mock never issued`);
    const matches = templates.filter((t) => t.m === r.method && t.re.test(r.path));
    assert.ok(matches.length, `undocumented call ${r.method} ${r.path}`);
    // Prefer the literal template (/contacts/search over /contacts/{id}).
    const tpl = (matches.find((t) => !t.p.includes("{")) ?? matches[0]).p;
    used.add(`${r.method} ${tpl}`);
    const documented = queryParams(r.method, tpl);
    for (const k of Object.keys(r.query)) assert.ok(documented.includes(k), `${r.method} ${tpl}: query parameter "${k}" is not documented`);
  }
  assert.deepEqual([...used].sort(), [
    "GET /attendances", "GET /auth/scopes", "GET /auth/user", "GET /campaigns", "GET /campaigns/{id}/stats", "GET /contacts/{id}", "GET /events", "GET /events/{id}",
    "GET /forms", "GET /labels", "GET /responses", "POST /attendances", "POST /contacts/search", "POST /contacts/{id}/replace_labels",
  ]);
});

mock.server.close();
console.log(`\n${passed} checks passed, ${requests.length} API calls made against the mock, ${((Date.now() - started) / 1000).toFixed(1)} s.`);
