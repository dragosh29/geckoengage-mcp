// Local stand-in for the Gecko Engage API (api-{region}.geckoform.com) and the GeckoAuth refresh endpoint
// (account-api.geckoengage.com/tokens/refresh), serving the fixtures with the documented Laravel-style
// pagination and Bearer-JWT authentication.
import http from "node:http";
import * as fx from "./fixtures.mjs";

export const TOKEN_PATH = "/tokens/refresh";

// Tokens are JWT-shaped (the server reads their `exp` and `region` claims) and are built at run time
// from plain JSON, so no token-like string is stored in the repository. They are unsigned
// ("alg": "none") and carry an obviously fake marker; the mock only checks that it issued them.
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
export const jwt = (payload) => `${b64url({ typ: "JWT", alg: "none" })}.${b64url(payload)}.test-signature-not-real`;
const now = () => Math.floor(Date.now() / 1000);

// Error bodies: the spec's MessageError { message, details } with the example messages it gives for
// each tag. The refresh endpoint's error body is not documented; the mock uses the same shape.
const UNAUTHENTICATED = { message: "Please authenticate to access this endpoint.", details: null };
const notFound = (what) => ({ message: `The ${what} you requested is not available.` });

export function startMock() {
  const requests = [];
  const issuedAccess = new Set(); // every access token ever issued (for the final auth check)
  const issued = []; // every token set issued, in order (the tests read the rotated Refresh tokens here)
  const validAccess = new Set();
  const validRefresh = new Set();
  let serial = 0;

  /** Issue a token set. `accessTtl` in seconds (negative = already expired). */
  const issue = ({ accessTtl = 86400, refreshTtl = 30 * 86400, region = "eu" } = {}) => {
    serial++;
    const access = jwt({ token_use: "access", region, exp: now() + accessTtl, jti: `gecko-test-access-${serial}-not-real` });
    const refresh = jwt({ token_use: "refresh", exp: now() + refreshTtl, jti: `gecko-test-refresh-${serial}-not-real` });
    const id = jwt({ token_use: "id", exp: now() + accessTtl, jti: `gecko-test-id-${serial}-not-real` });
    issuedAccess.add(access);
    validAccess.add(access);
    validRefresh.add(refresh);
    const set = { access, refresh, id, exp: now() + accessTtl };
    issued.push(set);
    return set;
  };

  // Mutable copies so the write tools can change them.
  const attendances = fx.attendances.map((a) => ({ ...a }));
  const contactLabels = Object.fromEntries(fx.contacts.map((c) => [c.id, c.labels.map((l) => l.id)]));

  // Injected failures: { method, path, status, times, headers, body }. Each matching request consumes one
  // "time". A body of undefined sends a non-JSON gateway page. The suite starts with a single 429 on
  // GET /forms so the retry path is exercised.
  let failures = [];
  const arm = ({ method, path, status, times = 1, headers, body }) => failures.push({ method, path, status, times, headers, body });
  const disarm = () => {
    failures = [];
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const auth = req.headers.authorization;
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), auth, bearer, body, t: Date.now() });

    const send = (status, json, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };

    const failure = failures.find((f) => f.times > 0 && f.method === req.method && f.path === path);
    if (failure) {
      failure.times--;
      if (failure.body === undefined) {
        res.writeHead(failure.status, { "Content-Type": "text/html", ...(failure.headers ?? {}) });
        return res.end(`<html><body><h1>${failure.status}</h1><p>gateway page for admissions@example.ac.uk</p></body></html>`);
      }
      const b = typeof failure.body === "function" ? failure.body({ bearer }) : failure.body;
      if (typeof b === "string") {
        res.writeHead(failure.status, { "Content-Type": "text/html", ...(failure.headers ?? {}) });
        return res.end(b);
      }
      return send(failure.status, b, failure.headers ?? {});
    }

    // GeckoAuth refresh: GET with the Refresh token as the Bearer token. Refresh tokens are single-use;
    // the answer holds all three new tokens (authentication guide, "Example refresh response").
    if (path === TOKEN_PATH) {
      if (req.method !== "GET") return send(405, { message: "Method not allowed" });
      if (!bearer || !validRefresh.has(bearer)) return send(401, { message: "The refresh token is invalid, expired or has already been used." });
      validRefresh.delete(bearer);
      const t = issue();
      return send(200, { AccessToken: t.access, IdToken: t.id, RefreshToken: t.refresh, ExpiresIn: t.exp, TokenType: null });
    }

    // Every API route in the spec uses Bearer JWT auth. An expired or unknown token gets the documented 401.
    const exp = (() => {
      try {
        return JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString()).exp;
      } catch {
        return 0;
      }
    })();
    if (!bearer || !validAccess.has(bearer) || exp <= now()) return send(401, UNAUTHENTICATED);

    // Laravel pagination. The spec documents per_page with a minimum of 1 and no maximum; the mock caps
    // pages at 10 records so the suite has to page. Parameters come from the query, or from the body on
    // POST /contacts/search.
    const params = req.method === "POST" && body && typeof body === "object" ? body : Object.fromEntries(url.searchParams);
    const paged = (items) => {
      const perPage = Math.min(Math.max(1, Number(params.per_page) || 15), 10);
      const page = Math.max(1, Number(params.page) || 1);
      const data = items.slice((page - 1) * perPage, page * perPage);
      return {
        current_page: page,
        data,
        from: data.length ? (page - 1) * perPage + 1 : null,
        last_page: Math.max(1, Math.ceil(items.length / perPage)),
        per_page: perPage,
        to: data.length ? (page - 1) * perPage + data.length : null,
        total: items.length,
      };
    };
    // The spec's filter syntax: a single value, or "@a|b|c" for several (and "@@a|b" for all-match).
    const multi = (v) => (v === undefined || v === null || v === "" ? undefined : String(v).startsWith("@") ? String(v).replace(/^@+/, "").split("|") : [String(v)]);
    const includes = (name) => String(params.include ?? "").split(",").includes(name);
    const counts = (name) => String(params.counts ?? "").split(",").includes(name);
    const rfields = (key, name) => String(params[key] ?? "").split(",").includes(name);
    // Soft-deleted attendances only with the documented trashed=1.
    const live = (a) => !fx.TRASHED_ATTENDANCE_IDS.has(a.id);

    const p = path.split("/").filter(Boolean);
    const m = req.method;

    if (m === "GET" && path === "/auth/user") return send(200, { user: fx.auth.user });
    if (m === "GET" && path === "/auth/scopes") return send(200, fx.auth.scopes);

    const eventView = (e, detail) => {
      const out = { ...e };
      // Spec: tags are an extra field, returned only when event_rfields names them.
      if (!rfields("event_rfields", "tags")) delete out.tags;
      if (counts("attendances")) out.attendances_count = attendances.filter((a) => a.event_id === e.id && live(a)).length;
      if (counts("responses")) out.responses_count = e.id === 2 ? 2 : 0;
      if (detail) {
        if (includes("children")) out.children = fx.events.filter((c) => c.parent_id === e.id).map((c) => ({ id: c.id, title: c.title, type: c.type, timezone: c.timezone, start_datetime: c.start_datetime, end_datetime: c.end_datetime, delivery_method: c.delivery_method }));
        if (includes("location") && fx.eventLocations[e.id]) out.location = fx.eventLocations[e.id];
        if (includes("categories")) out.categories = fx.eventCategories[e.id] ?? [];
      }
      return out;
    };

    if (p[0] === "events" && m === "GET") {
      if (p.length === 1) {
        const kw = params.keyword?.toLowerCase();
        const statuses = multi(params.status);
        const types = multi(params.type)?.map(Number);
        const cats = params.category_id ? String(params.category_id).split(",").map(Number) : undefined; // spec: comma-separated
        const methods = multi(params.delivery_method);
        const parent = params.parent_id !== undefined ? Number(params.parent_id) : undefined;
        const items = fx.events.filter(
          (e) =>
            (!kw || [e.title, e.internal_title, e.country].some((x) => x?.toLowerCase().includes(kw))) &&
            (!statuses || statuses.includes(e.status)) &&
            (!types || types.includes(e.type)) &&
            (!cats || (fx.eventCategories[e.id] ?? []).some((c) => cats.includes(c.id))) &&
            (!methods || methods.includes(e.delivery_method)) &&
            (parent === undefined || e.parent_id === parent),
        );
        const page = paged(items);
        return send(200, { ...page, data: page.data.map((e) => eventView(e, false)) });
      }
      const e = fx.events.find((x) => String(x.id) === p[1]);
      if (!e) return send(404, notFound("event"));
      if (p.length === 2) return send(200, { event: eventView(e, true) });
    }

    const attendanceView = (a) => {
      const out = { ...a };
      if (includes("contact")) {
        const c = fx.contacts.find((x) => x.id === a.contact_id);
        if (c) out.contact = { id: c.id, uuid: c.uuid, full_name: c.full_name, email: c.email, qr_url: c.qr_url };
      }
      if (includes("event")) {
        const e = fx.events.find((x) => x.id === a.event_id);
        if (e) out.event = { id: e.id, parent_id: e.parent_id, title: e.title, type: e.type, start_datetime: e.start_datetime, end_datetime: e.end_datetime };
      }
      return out;
    };

    if (p[0] === "attendances" && p.length === 1) {
      if (m === "GET") {
        const ev = multi(params.event_id)?.map(Number);
        const ct = multi(params.contact_id)?.map(Number);
        const st = multi(params.status)?.map(Number);
        const trashed = String(params.trashed) === "1";
        const items = attendances.filter((a) => (trashed || live(a)) && (!ev || ev.includes(a.event_id)) && (!ct || ct.includes(a.contact_id)) && (!st || st.includes(a.status)));
        const page = paged(items);
        return send(200, { ...page, data: page.data.map(attendanceView) });
      }
      if (m === "POST") {
        // Attendances_AttendanceStoreRequest: contact_id and event_id required.
        if (!Number.isInteger(body?.contact_id) || !Number.isInteger(body?.event_id)) return send(400, { message: "The contact and event are required." });
        if (!fx.contacts.some((c) => c.id === body.contact_id) || !fx.events.some((e) => e.id === body.event_id)) return send(400, { message: "The contact or event could not be found." });
        const status = body.status === "waitlist" ? 50 : 10;
        const a = fx.mkAttendance(body.contact_id, body.event_id, status, { guest_count: body.guest_count ?? 0 });
        attendances.push(a);
        return send(200, { attendance: a });
      }
    }

    if (p[0] === "forms" && m === "GET" && p.length === 1) {
      const kw = params.keyword?.toLowerCase();
      const modules = multi(params.module);
      const published = multi(params.published)?.map(Number);
      const items = fx.forms.filter((f) => (!kw || [f.name, f.internal_name, f.uuid].some((x) => x.toLowerCase().includes(kw))) && (!modules || modules.includes(f.module)) && (!published || published.includes(f.published)) && (!params.group || f.group === params.group));
      const page = paged(items);
      return send(200, { ...page, data: page.data.map((f) => (counts("responses") ? { ...f, responses_count: fx.responses.filter((r) => r.form_id === f.id).length } : f)) });
    }

    if (p[0] === "responses" && m === "GET" && p.length === 1) {
      const formIds = multi(params.form_id)?.map(Number);
      const labelIds = multi(params.label)?.map(Number);
      const kw = params.response_keyword?.toLowerCase();
      // Spec: "By default the route excludes responses for forms belonging to the `application` module;
      // set `module=application` to query that response set instead." `module` takes a single value.
      const moduleOf = (r) => fx.forms.find((f) => f.id === r.form_id)?.module;
      const inModule = (r) => (params.module ? moduleOf(r) === params.module : moduleOf(r) !== "application");
      const items = fx.responses.filter((r) => inModule(r) && (!formIds || formIds.includes(r.form_id)) && (!labelIds || r.label_ids.some((l) => labelIds.includes(l))) && (!kw || r.email.toLowerCase().includes(kw)));
      const page = paged(items);
      const view = (r) => {
        const out = { ...r };
        // label_ids is an extra computed field, returned only when response_rfields names it.
        if (!rfields("response_rfields", "label_ids")) delete out.label_ids;
        if (includes("labels")) out.labels = fx.responseLabels(r);
        return out;
      };
      return send(200, { ...page, data: page.data.map(view) });
    }

    const contactView = (c) => {
      const out = { ...c, labels: contactLabels[c.id].map((id) => fx.labels.find((l) => l.id === id)).map((l) => ({ id: l.id, name: l.name, color: l.color })) };
      if (!includes("labels")) delete out.labels;
      if (includes("current_values.field") || includes("current_values")) out.current_values = fx.currentValues[c.id] ?? [];
      if (counts("attendances")) out.attendances_count = attendances.filter((a) => a.contact_id === c.id && live(a)).length;
      if (counts("responses")) out.responses_count = fx.responses.filter((r) => r.contact_id === c.id).length;
      return out;
    };

    if (p[0] === "contacts") {
      if (m === "POST" && p[1] === "search" && p.length === 2) {
        const kw = params.keyword?.toLowerCase();
        const labelIds = multi(params.label)?.map(Number);
        const eventId = params.attendance_event_id;
        const items = fx.contacts.filter(
          (c) =>
            (!kw || c.full_name.toLowerCase().includes(kw) || c.email.toLowerCase().includes(kw)) &&
            (!labelIds || contactLabels[c.id].some((l) => labelIds.includes(l))) &&
            (eventId === undefined || attendances.some((a) => live(a) && a.contact_id === c.id && a.event_id === eventId)) &&
            (!params.email || c.email.toLowerCase() === String(params.email).toLowerCase()),
        );
        const page = paged(items);
        return send(200, { ...page, data: page.data.map(contactView) });
      }
      if (!/^(\d+|[0-9A-Za-z]{26})$/.test(p[1] ?? "")) return send(400, { message: "ID is not in a valid format; please try again" });
      const c = fx.contacts.find((x) => String(x.id) === p[1] || x.contactId === p[1]);
      if (!c) return send(404, notFound("contact"));
      if (m === "GET" && p.length === 2) return send(200, { contact: contactView(c) });
      if (m === "POST" && p.length === 3 && p[2] === "replace_labels") {
        const ids = Array.isArray(body?.labels) ? body.labels.map((l) => (typeof l === "object" ? l.id : l)) : [];
        if (ids.some((id) => !fx.labels.some((l) => l.id === id))) return send(400, { messages: { labels: ["One or more labels are invalid."] } });
        contactLabels[c.id] = ids;
        return send(200, { contact: contactView(c) });
      }
    }

    if (p[0] === "labels" && m === "GET" && p.length === 1) {
      const kw = params.keyword?.toLowerCase();
      const ids = multi(params.id)?.map(Number);
      return send(200, paged(fx.labels.filter((l) => (!kw || l.name.toLowerCase().includes(kw)) && (!ids || ids.includes(l.id)))));
    }

    if (p[0] === "campaigns" && m === "GET") {
      if (p.length === 1) {
        const kw = params.keyword?.toLowerCase();
        const st = multi(params.status)?.map(Number);
        const mods = multi(params.module);
        const items = fx.campaigns.filter((c) => (!kw || c.title.toLowerCase().includes(kw)) && (!st || st.includes(c.status)) && (!mods || mods.includes(c.module)));
        const page = paged(items);
        // subscribers_count only when asked for with counts=subscribers.
        return send(200, { ...page, data: page.data.map((c) => (counts("subscribers") ? c : (({ subscribers_count, ...rest }) => rest)(c))) });
      }
      const c = fx.campaigns.find((x) => String(x.id) === p[1]);
      if (!c) return send(404, notFound("campaign"));
      if (p.length === 3 && p[2] === "stats") {
        if (!params.from || !params.to) return send(400, { message: "The from and to parameters are required." });
        return send(200, fx.campaignStats(c.id, params.from, params.to, params.group ?? "daily"));
      }
    }

    return send(404, { message: "The resource you requested was not found." });
  });

  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: server.address().port,
        requests,
        issue,
        arm,
        disarm,
        issuedAccess,
        issued,
        revoke: (token) => validAccess.delete(token),
        refreshValid: (token) => validRefresh.has(token),
        attendances,
        contactLabels,
      }),
    ),
  );
}
