// Minimal Gecko Engage API client used by the MCP tools.
// Docs: https://docs.geckoengage.com/docs/authentication  Spec: https://docs.geckoengage.com/openapi/engage-openapi.yml
// (OpenAPI 3.0.3, "Engage API" 1.0.0).
import { redactContacts } from "./format.js";

export class GeckoError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "GeckoError";
  }
}

// Every list response in the spec is a Laravel-style page: current_page, data, from, last_page,
// per_page, to, total (per_page and total are integer-or-string on the contacts collection).
export interface Page<T> {
  current_page?: number | string;
  last_page?: number | string;
  per_page?: number | string;
  total?: number | string;
  data?: T[];
}

// Authentication guide, "Accessing the API": the Access token carries a `region` claim, and each
// region has its own API host.
export const REGION_URLS: Record<string, string> = {
  eu: "https://api-eu.geckoform.com",
  "us-e": "https://api-us-e.geckoform.com",
  ca: "https://api-ca.geckoform.com",
};
// Authentication guide, "Check whether refresh is due": the GeckoAuth refresh endpoint, called with
// the Refresh token as the Bearer token. It is not part of the OpenAPI spec (another host).
export const DEFAULT_TOKEN_URL = "https://account-api.geckoengage.com/tokens/refresh";

// A 429 means the request was not processed, so it is safe to repeat for any method. A 502/503/504
// from a gateway does not prove the upstream did not process the request, so those are only retried
// for GET requests to the API. The token refresh is a GET too, but the refresh token is single-use:
// a gateway error may hide a refresh that already consumed it, so it is never retried after one.
const RETRY_ANY_METHOD = new Set([429]);
const RETRY_GET_ONLY = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;
// Longest single wait honoured from Retry-After. The MCP SDK's default request timeout is 60 s
// (DEFAULT_REQUEST_TIMEOUT_MSEC), so the whole retry budget (at most two waits) must stay well
// under that; a longer Retry-After makes the call give up at once with the wait time in the message.
export const MAX_RETRY_AFTER_S = 10;
// Refresh this long before the Access token's `exp` claim.
const REFRESH_MARGIN_S = 60;
// The spec documents `per_page` with a minimum of 1 and no maximum. 100 is this server's own cap.
export const MAX_PER_PAGE = 100;

export type QueryValue = string | number | boolean | undefined;

const WHERE_TOKENS = "Gecko under Security Preferences -> Active Sessions -> Create New API Token";

/** The JSON payload of a JWT, without verifying it (only `exp` and `region` are read). */
export function jwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  const part = token?.split(".")[1];
  if (!part) return undefined;
  try {
    const json = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return json && typeof json === "object" && !Array.isArray(json) ? json : undefined;
  } catch {
    return undefined;
  }
}

/** The regional API base URL for an Access token, from its `region` claim. */
export function regionBaseUrl(accessToken: string): string {
  const payload = jwtPayload(accessToken);
  if (!payload) throw new GeckoError("GECKO_ACCESS_TOKEN is not a readable JWT, so its region cannot be found. Copy the Access token again, or set GECKO_BASE_URL to your region's API (https://api-eu.geckoform.com, https://api-us-e.geckoform.com or https://api-ca.geckoform.com).");
  const region = typeof payload.region === "string" ? payload.region : undefined;
  const url = region ? REGION_URLS[region] : undefined;
  if (!url) {
    throw new GeckoError(
      `The Access token's region claim is ${region ? JSON.stringify(region) : "missing"}; the documented regions are eu, us-e and ca. Set GECKO_BASE_URL to your region's API host.`,
    );
  }
  return url;
}

function withoutUserinfo(raw: string, variable: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GeckoError(`${variable} is not a valid URL.`);
  }
  if (url.username || url.password) throw new GeckoError(`${variable} must not contain a username or password.`);
  return raw.replace(/\/+$/, "");
}

const expOf = (token: string | undefined): number | undefined => {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp : undefined;
};
const isoOf = (unix: number) => new Date(unix * 1000).toISOString();
const clean = (t: string | undefined) => t?.trim().replace(/^bearer\s+/i, "").trim() || undefined;

export interface ClientOptions {
  accessToken: string;
  refreshToken?: string;
  baseUrl?: string;
  tokenUrl?: string;
  /** Called after every successful refresh (the server logs a warning to stderr). */
  onRefresh?: () => void;
}

export class GeckoClient {
  private readonly fixedBaseUrl?: string;
  private readonly tokenUrl: string;
  // The three tokens the guide says to keep. They live in memory only: after a refresh the values
  // in the environment are stale (the refresh token is single-use), so a restart needs new tokens.
  private tokens: { access: string; refresh?: string; id?: string };
  private refreshInFlight?: Promise<void>;
  private readonly onRefresh?: () => void;
  // Every token this client has held; error messages are scrubbed against them.
  private readonly secrets = new Set<string>();
  // Gecko does not document a rate limit. Space requests at about four per second so a tool call
  // that pages through a list stays polite; 429s are retried using Retry-After.
  private nextSlot = 0;
  private readonly minIntervalMs = 250;

  constructor(opts: ClientOptions) {
    const access = clean(opts.accessToken);
    if (!access) throw new GeckoError(`GECKO_ACCESS_TOKEN is not set. Create an API token in ${WHERE_TOKENS} and copy its Access and Refresh tokens.`);
    this.tokens = { access, refresh: clean(opts.refreshToken) };
    this.fixedBaseUrl = opts.baseUrl ? withoutUserinfo(opts.baseUrl, "GECKO_BASE_URL") : undefined;
    this.tokenUrl = withoutUserinfo(opts.tokenUrl || DEFAULT_TOKEN_URL, "GECKO_TOKEN_URL");
    this.onRefresh = opts.onRefresh;
    this.remember(access, this.tokens.refresh);
    // Fail at start-up rather than on the first call when the region cannot be worked out.
    if (!this.fixedBaseUrl) regionBaseUrl(access);
  }

  private remember(...values: Array<string | undefined>) {
    for (const v of values) if (v && v.length >= 8) this.secrets.add(v);
  }

  /** Replace every token this client has held with "[redacted]". */
  private scrub(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join("[redacted]");
    return out;
  }

  get baseUrl(): string {
    return this.fixedBaseUrl ?? regionBaseUrl(this.tokens.access);
  }

  /** What the tools may show about the credentials: the region and the expiry times, never a token. */
  tokenInfo() {
    const payload = jwtPayload(this.tokens.access);
    const accessExp = expOf(this.tokens.access);
    const refreshExp = expOf(this.tokens.refresh);
    return {
      region: typeof payload?.region === "string" ? payload.region : undefined,
      api: this.baseUrl,
      access_token_expires: accessExp ? isoOf(accessExp) : undefined,
      refresh_token_configured: this.tokens.refresh !== undefined,
      refresh_token_expires: refreshExp ? isoOf(refreshExp) : undefined,
    };
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  /** One HTTP exchange with throttling and the 429 / gateway retry policy; no auth handling. */
  private async send(method: string, url: URL, init: { headers: Record<string, string>; body?: string; gatewayRetry: boolean; shown: string }) {
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await fetch(url, { method, headers: init.headers, body: init.body });
      } catch (err) {
        throw new GeckoError(`Could not reach Gecko at ${url.origin}${url.pathname}: ${(err as Error).message}. Check the URL and the network.`);
      }
      const retryable = RETRY_ANY_METHOD.has(res.status) || (init.gatewayRetry && RETRY_GET_ONLY.has(res.status));
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) {
          throw new GeckoError(`Gecko asked to wait ${Math.ceil(retryAfter)} seconds before retrying ${init.shown} (HTTP ${res.status}). Try again after that.`, res.status);
        }
        // A missing or unparsable header falls back to 2 s then 4 s; a Retry-After of 0 (or a date
        // already passed) means retry now, subject to the throttle.
        const delay = retryAfter !== undefined ? retryAfter * 1000 : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      const text = res.status === 204 ? "" : await res.text();
      return { status: res.status, text, json: text ? safeJson(text) : undefined };
    }
  }

  /**
   * Make sure the Access token is usable: a token whose `exp` is less than a minute away is refreshed
   * first when a refresh token is configured, and reported as expired (without any request) when not.
   */
  private async ensureFresh(): Promise<void> {
    const exp = expOf(this.tokens.access);
    if (exp === undefined || exp * 1000 - Date.now() > REFRESH_MARGIN_S * 1000) return;
    if (!this.tokens.refresh) {
      throw new GeckoError(`The Gecko Access token expired at ${isoOf(exp)} and no GECKO_REFRESH_TOKEN is set. Create a new API token in ${WHERE_TOKENS} and set GECKO_ACCESS_TOKEN and GECKO_REFRESH_TOKEN.`, 401);
    }
    await this.refresh(this.tokens.access);
  }

  /**
   * Authentication guide, "Refreshing your JWT": GET the GeckoAuth refresh endpoint with the Refresh
   * token as the Bearer token; the answer holds AccessToken, IdToken and RefreshToken, all of which
   * replace the old ones (refresh tokens can only be used once). `staleAccess` is the Access token
   * the caller found unusable: if another call has already replaced it, nothing is done, and
   * concurrent callers share one refresh.
   */
  private refresh(staleAccess: string): Promise<void> {
    if (this.tokens.access !== staleAccess) return Promise.resolve();
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.doRefresh().finally(() => {
        this.refreshInFlight = undefined;
      });
    }
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<void> {
    const refresh = this.tokens.refresh;
    if (!refresh) throw new GeckoError(`Gecko rejected the Access token and no GECKO_REFRESH_TOKEN is set to renew it. Create a new API token in ${WHERE_TOKENS} and set GECKO_ACCESS_TOKEN and GECKO_REFRESH_TOKEN.`, 401);
    const refreshExp = expOf(refresh);
    if (refreshExp !== undefined && refreshExp * 1000 <= Date.now()) {
      throw new GeckoError(`The Gecko Refresh token expired at ${isoOf(refreshExp)} (they last about 30 days). Create a new API token in ${WHERE_TOKENS} and set GECKO_ACCESS_TOKEN and GECKO_REFRESH_TOKEN.`, 401);
    }
    const url = new URL(this.tokenUrl);
    const { status, json } = await this.send("GET", url, {
      headers: { Authorization: `Bearer ${refresh}`, Accept: "application/json" },
      gatewayRetry: false,
      shown: `GET ${url.pathname}`,
    });
    const where = `${url.origin}${url.pathname}`;
    const detail = this.detail(json);
    if (status === 200 && json && typeof json === "object" && typeof json.AccessToken === "string" && json.AccessToken && typeof json.RefreshToken === "string" && json.RefreshToken) {
      this.tokens = { access: json.AccessToken, refresh: json.RefreshToken, id: typeof json.IdToken === "string" ? json.IdToken : undefined };
      this.remember(this.tokens.access, this.tokens.refresh, this.tokens.id);
      this.onRefresh?.();
      return;
    }
    if (status === 200) {
      // Say what shape came back without echoing any value: the body may hold tokens under other keys.
      const shape = json && typeof json === "object" ? `JSON with keys ${Object.keys(json).join(", ") || "(none)"}` : "a body that is not JSON";
      throw new GeckoError(`Gecko answered ${where} with 200 but without AccessToken and RefreshToken (${shape}). Check GECKO_TOKEN_URL.`, status);
    }
    if (status === 400 || status === 401 || status === 403) {
      throw new GeckoError(
        `Gecko rejected the refresh token at ${where} (${status}). Refresh tokens can only be used once and expire after about 30 days; if this token was already used (by this server before a restart, or by anything else), it is no longer valid. Create a new API token in ${WHERE_TOKENS} and set GECKO_ACCESS_TOKEN and GECKO_REFRESH_TOKEN.${detail}`,
        status,
      );
    }
    if (status === 429) throw new GeckoError(`Gecko rate-limited the token refresh at ${where} (429). Wait a minute and try again.${detail}`, status);
    if (RETRY_GET_ONLY.has(status)) {
      throw new GeckoError(
        `Gecko returned ${status} for the token refresh at ${where}. It was not retried, because refresh tokens are single-use and the refresh may already have happened. Try the call again; if Gecko then rejects the tokens, create a new API token in ${WHERE_TOKENS}.`,
        status,
      );
    }
    throw new GeckoError(`Gecko returned ${status} for the token refresh at ${where}. Check GECKO_TOKEN_URL.${detail}`, status);
  }

  /** A JSON error message from Gecko, redacted and scrubbed, prefixed with a space; "" when none. */
  private detail(json: unknown): string {
    const d = describeError(json);
    if (!d) return "";
    return " " + (redactContacts(this.scrub(d), false) ?? "").slice(0, 300);
  }

  async request<T = any>(method: string, path: string, opts: { query?: Record<string, QueryValue>; body?: unknown } = {}): Promise<T> {
    try {
      return await this.requestOnce<T>(method, path, opts);
    } catch (err) {
      // Belt and braces: no error that leaves the client may carry a token.
      if (err instanceof GeckoError) throw new GeckoError(this.scrub(err.message), err.status);
      if (err instanceof Error) err.message = this.scrub(err.message);
      throw err;
    }
  }

  private async requestOnce<T>(method: string, path: string, opts: { query?: Record<string, QueryValue>; body?: unknown }): Promise<T> {
    await this.ensureFresh();
    for (let auth = 0; ; auth++) {
      const used = this.tokens.access;
      const url = new URL(this.baseUrl + path);
      for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
      const shown = `${method} ${path}`;
      const { status, text, json } = await this.send(method, url, {
        headers: {
          Authorization: `Bearer ${used}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        gatewayRetry: method === "GET",
        shown,
      });

      // A 401 with a refresh token configured: renew the tokens (or pick up the ones another call has
      // just renewed) and try once more.
      if (status === 401 && auth === 0 && (this.tokens.access !== used || this.tokens.refresh)) {
        await this.refresh(used);
        continue;
      }
      if (status === 204) return undefined as T;
      if (status >= 200 && status < 300) {
        // Every documented 2xx body is JSON. A 200 with HTML (a proxy, a login page) must not be
        // mistaken for an empty list or an empty record; nothing of such a body is quoted.
        if (json === undefined || typeof json !== "object" || json === null) {
          throw new GeckoError(`Gecko returned ${status} for ${shown} but the body was not JSON (${text.length} bytes). Check GECKO_BASE_URL and whether a proxy or login page is in the way.`, status);
        }
        return json as T;
      }

      // Gecko's error bodies are { message, details }, { messages } or { success: false, errors }.
      // Only a JSON message is passed on, redacted; a non-JSON body (a gateway page) is never quoted.
      const detail = this.detail(json);
      if (status === 401) {
        throw new GeckoError(
          `Gecko rejected the Access token (401) for ${shown}${this.tokens.refresh ? ", even after refreshing it" : ""}. Check GECKO_ACCESS_TOKEN${this.tokens.refresh ? " and GECKO_REFRESH_TOKEN" : " (and set GECKO_REFRESH_TOKEN so it can be renewed)"}; tokens come from ${WHERE_TOKENS}.${detail}`,
          401,
        );
      }
      if (status === 403) {
        throw new GeckoError(`Gecko refused ${shown} (403): the API token does not have the permission for this. Call whoami to see which scopes the token has, and create a token with the missing permission if needed.${detail}`, 403);
      }
      if (status === 404) throw new GeckoError(`Not found: ${path}. Check the ID.${detail}`, 404);
      if (status === 429) throw new GeckoError(`Gecko rate limit reached (the limit is not documented). Wait a minute and try again.${detail}`, 429);
      if (status === 400 || status === 422) throw new GeckoError(`Gecko refused ${shown} (${status}).${detail}`, status);
      if (method !== "GET" && RETRY_GET_ONLY.has(status)) {
        throw new GeckoError(`Gecko returned ${status} for ${shown}. The request was not retried because it may already have been processed: check with the matching list or get tool before repeating it.${detail}`, status);
      }
      if (RETRY_GET_ONLY.has(status)) {
        throw new GeckoError(`Gecko returned ${status} for ${shown} ${MAX_ATTEMPTS} times in a row. The service may be unavailable; try again in a few minutes.${detail}`, status);
      }
      throw new GeckoError(`Gecko returned ${status} for ${shown}.${detail}`, status);
    }
  }

  get<T = any>(path: string, query?: Record<string, QueryValue>) {
    return this.request<T>("GET", path, { query });
  }

  /**
   * Walk a Laravel-style paginated collection: pages `startPage` to `startPage + maxPages - 1`, stopping
   * early at the documented end (`current_page >= last_page`) or at an empty page. `fetchPage` makes
   * the request for one page (a GET with page/per_page in the query, or the POST search with them in
   * the body). Pages are always returned whole, so continuing from `next_page` with the same
   * `per_page` never skips a record.
   */
  async list<T = any>(
    fetchPage: (page: number, perPage: number) => Promise<Page<T>>,
    { startPage = 1, perPage = 50, maxPages = 4 }: { startPage?: number; perPage?: number; maxPages?: number } = {},
  ): Promise<{ items: T[]; total?: number; last_page?: number; complete: boolean; next_page?: number; pages_fetched: number }> {
    const items: T[] = [];
    let total: number | undefined;
    let lastPage: number | undefined;
    let page = startPage;
    for (let n = 0; n < maxPages; n++, page++) {
      const res = await fetchPage(page, perPage);
      const data = Array.isArray(res?.data) ? res.data : [];
      items.push(...data);
      const t = Number(res?.total);
      if (res?.total !== undefined && Number.isFinite(t)) total = t;
      const lp = Number(res?.last_page);
      if (res?.last_page !== undefined && Number.isFinite(lp)) lastPage = lp;
      const current = Number(res?.current_page ?? page);
      const done = data.length === 0 || (lastPage !== undefined ? current >= lastPage : data.length < perPage);
      if (done) return { items, total, last_page: lastPage, complete: true, pages_fetched: n + 1 };
    }
    return { items, total, last_page: lastPage, complete: false, next_page: page, pages_fetched: maxPages };
  }
}

/**
 * Retry-After in seconds, from either form allowed by RFC 9110 (delay-seconds or an HTTP-date).
 * A fractional number is accepted as seconds too. Anything else that is not an HTTP-date (which always
 * names a month, so contains letters) gives undefined, so the caller's fallback applies; without that
 * check Date.parse("1.5") would be read as a date in 2001 and the retry would happen at once.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const h = header.trim();
  if (/^\d+(\.\d+)?$/.test(h)) return Number(h);
  if (!/[A-Za-z]/.test(h)) return undefined;
  const at = Date.parse(h);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, (at - now) / 1000);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The spec's three error shapes: MessageError { message, details }, ValidationMessagesError
// { messages: string[] | { field: string[] } } and StructuredErrorResponse { success: false, errors: [{ code, title, detail }] }.
function describeError(json: any): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const parts: string[] = [];
  if (typeof json.message === "string" && json.message.trim()) parts.push(json.message.trim());
  if (typeof json.details === "string" && json.details.trim()) parts.push(json.details.trim());
  const m = json.messages;
  if (Array.isArray(m)) parts.push(m.filter((x) => typeof x === "string").join(" "));
  else if (m && typeof m === "object") {
    for (const [field, v] of Object.entries(m)) parts.push(`${field}: ${Array.isArray(v) ? v.filter((x) => typeof x === "string").join(" ") : typeof v === "string" ? v : ""}`.trim());
  }
  if (Array.isArray(json.errors)) {
    for (const e of json.errors) if (e && typeof e === "object") parts.push([e.title, e.detail].filter((x) => typeof x === "string" && x).join(": ") + (e.code !== undefined ? ` (code ${e.code})` : ""));
  }
  const out = parts.filter(Boolean).join(" ");
  return out || undefined;
}

/**
 * The spec's "pipe-delimited array syntax" for filters that take several values: `@a|b|c`. A single
 * value is sent as it is.
 */
export function pipe(values: Array<string | number> | undefined): string | undefined {
  if (!values || values.length === 0) return undefined;
  return values.length === 1 ? String(values[0]) : `@${values.join("|")}`;
}
