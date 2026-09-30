# Gecko Engage MCP server

An [MCP](https://modelcontextprotocol.io) server that lets Claude, ChatGPT and other MCP clients work with a Gecko Engage account, the student recruitment and engagement CRM used by universities and colleges: events and their sessions, bookings (attendances), forms and form responses, contacts (prospective students), labels and campaigns, and (when enabled) registering a contact for an event and adding a label to a contact. It is built from Gecko's public developer documentation: the Engage API OpenAPI 3.0.3 document at `docs.geckoengage.com/openapi/engage-openapi.yml` and the authentication guide at `docs.geckoengage.com/docs/authentication`.

Once it's connected, someone in the admissions or recruitment team can ask things like:

- "How many people are booked on the Autumn Open Day, and how many are on the waitlist?"
- "Which sessions does the open day have, and when?"
- "How many responses has the Undergraduate Enquiry form had?"
- "Find Priya Shah. Which events has she booked, and did she attend?"
- "How did last week's WhatsApp open-day reminder do: delivered, read?"
- With writes enabled: "Book Sam Evans onto the Spring Open Day." / "Add the Scholarship interest label to Sam."

## Tools

| Tool | What it does | API calls |
|---|---|---|
| `whoami` | The Gecko user the token belongs to, the token's region and expiry times (never the token), and which API scopes it has. | `GET /auth/user`, `GET /auth/scopes` |
| `list_events` | Events, sessions and session times with schedule, delivery method, capacity, tags (asked for with `event_rfields=tags`) and the number of attendances and responses. Filters `keyword`, `status`, `type`, `category_id`, `delivery_method`, `parent_id`. | `GET /events` |
| `get_event` | One event with its description as plain text, location, categories, tags, sessions and session times, and counts. | `GET /events/{id}` |
| `list_attendances` | Bookings for an event and/or a contact, with status, guest count and a count per status. Filters `event_id`, `contact_id`, `status`. | `GET /attendances` |
| `list_forms` | Forms with module, group, published, expired and full flags and their number of responses. Filters `keyword`, `module`, `published`, `group`. | `GET /forms` |
| `list_form_responses` | Form submissions with form, contact ID, draft or completed, labels (names, and IDs asked for with `response_rfields=label_ids`) and time. Filters `form_id`, `label`, `module`, `response_keyword`. As the API does by default, quarantined responses and responses to application-module forms are left out; `module=application` lists the application responses instead. The answers are not fetched. | `GET /responses` |
| `search_contacts` | Find contacts by `keyword`, `label`, `attendance_event_id` or `email`. | `POST /contacts/search` (a documented read) |
| `get_contact` | One contact by numeric ID or ULID: name, labels, preferred language, counts; contact fields only on request. | `GET /contacts/{id}` |
| `list_labels` | Labels with their IDs. Filter `keyword`. | `GET /labels` |
| `list_campaigns` | Campaigns with channel, status, schedule and subscribers. Filters `keyword`, `status`, `module`. | `GET /campaigns` |
| `get_campaign_stats` | Delivery and read stats for a WhatsApp broadcast campaign over a date range, in total and per period. The days are sent as `YYYY-MM-DD 00:00:00` and `YYYY-MM-DD 23:59:59`, so the last day is included, as in the spec's example. | `GET /campaigns/{id}/stats` |
| `register_contact_for_event` | Books a contact onto an event or its waitlist. Because the endpoint is "create or update", it first looks up the contact's attendances on that event, deleted ones included (`trashed=1`), and refuses if there is any. The check is a separate read, not atomic with the booking: two calls for the same contact and event at the same moment could both pass it. Writes only. | `GET /attendances`, `POST /attendances` |
| `add_contact_label` | Adds an existing label to a contact, keeping their other labels. Writes only, marked destructive (see Safety defaults). | `GET /labels`, `GET /contacts/{id}`, `POST /contacts/{id}/replace_labels` |

Not covered on purpose: everything else in a 458-operation API, including conversations and chat, calls, messages and sending email or SMS, workflows, imports and exports, files and every download (iCalendar files, Wallet passes, conversation exports), payments and transactions, users, integrations, deleting or merging anything, and the separate Portal API.

## Setup

Requires Node 18 or later.

```bash
npm install
npm run build
```

You need an API token for your Gecko account. As the authentication guide describes: ideally sign in as a dedicated API user in an "API Users" group with only the permissions needed (for this server's read tools, viewing events, attendances, forms, responses, contacts, labels and campaigns), go to **Security Preferences -> Active Sessions -> Create New API Token**, pick the profile and permissions, and copy the **Access** and **Refresh** tokens.

How the server uses them, following the guide:

- The Access token is sent as `Authorization: Bearer …` to the regional API named in its `region` claim: `eu` is `https://api-eu.geckoform.com`, `us-e` is `https://api-us-e.geckoform.com`, `ca` is `https://api-ca.geckoform.com`. The server refuses to start if the claim is missing or names another region, unless `GECKO_BASE_URL` is set.
- Access tokens last about a day. When the token's `exp` claim is less than a minute away, or the API answers 401, the server calls `GET https://account-api.geckoengage.com/tokens/refresh` with the Refresh token as the Bearer token and switches to the new Access, ID and Refresh tokens it gets back. Calls that need a refresh at the same moment share one.
- **Refresh tokens can only be used once, and the new tokens are kept in memory only.** After the server has refreshed once, the Refresh token in your configuration is spent: when the server restarts, it cannot renew its tokens, and you need to create a new API token and update both variables. (The refresh token itself lasts about 30 days.) The server logs a warning to stderr each time it refreshes.

**Claude Desktop:** add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "geckoengage": {
      "command": "node",
      "args": ["/absolute/path/to/geckoengage-mcp/dist/index.js"],
      "env": { "GECKO_ACCESS_TOKEN": "your-access-token", "GECKO_REFRESH_TOKEN": "your-refresh-token" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add geckoengage -e GECKO_ACCESS_TOKEN=your-access-token -e GECKO_REFRESH_TOKEN=your-refresh-token -- node /absolute/path/to/geckoengage-mcp/dist/index.js
```

| Variable | Required | Meaning |
|---|---|---|
| `GECKO_ACCESS_TOKEN` | yes | The Access token, sent as a Bearer token. A value pasted with its `Bearer ` prefix is accepted. |
| `GECKO_REFRESH_TOKEN` | recommended | The Refresh token, used once to renew the tokens (see above). Without it the server works until the Access token expires and then says so without making a request. |
| `GECKO_ALLOW_WRITES` | no | `true` to register `register_contact_for_event` and `add_contact_label`. Off by default. |
| `GECKO_BASE_URL` | no | Overrides the API host taken from the token's region. Used by the tests. Must not contain a username or password. |
| `GECKO_TOKEN_URL` | no | Overrides the refresh endpoint, `https://account-api.geckoengage.com/tokens/refresh`. Used by the tests. Same rule. |

## Safety defaults

- Read-only unless `GECKO_ALLOW_WRITES=true`. Read tools carry the MCP `readOnlyHint` annotation. The only `POST` a read tool makes is `POST /contacts/search`, which the spec documents as a search returning contacts. `register_contact_for_event` is annotated as a non-destructive write. `add_contact_label` is annotated destructive, because the API has no "add one label" call: the tool reads the contact's labels and sends the whole set back through "replace the contact's labels". A label someone else adds or removes in between can therefore be overwritten. It sends nothing when the contact already has the label, and refuses an unknown label ID.
- Gecko's contacts are prospective students, many of them under 18. By default a contact, attendee or response is identified by ID and name only. Email addresses (of contacts, attendees, responses and the API user) are only returned when a tool is called with `include_contact_details=true`. A contact's field values, which hold things like phone numbers, addresses, dates of birth and schools, are not even requested from the API unless `get_contact` is called that way. Form answers are never requested.
- Never returned, even on request: payment data on bookings (`payment_status`, `payment_transaction_id`, `payment_url`, `payment_response_id`); contact fields whose label, tag or type looks like bank, card or payment data (the pattern covers bank, IBAN, BIC, SWIFT, sort code, account number, card, CVV/CVC, payment and expiry; the tests exercise a bank account field and a card number field); and the personal links Gecko issues for a student, which open their portal or booking without signing in (`portal_url`, `qr_url`, `short_qr_url`, `events_page`, `available_auth_methods`, and a booking's `rsvp`, `ical`, `passbook` and `video_page`). No file is ever downloaded.
- In free text (names, event titles, internal titles, countries, tags and descriptions, form names and groups, label names, campaign titles and descriptions, and Gecko's own error messages) email addresses are replaced with `[email redacted]` and phone-number-like sequences with `[phone redacted]` by default. The phone match is a heuristic: it covers international numbers written with `+` or `00` (including the `+44 (0)7700 …` form), UK numbers with a bracketed area code such as `(020) 7946 0958`, and UK-style `0…` numbers of 9 to 11 digits with spaces, dots or hyphens between groups. Other digit strings of that shape that start with `0` are redacted too. Tools that return free text take `include_contact_details` to turn this off. Form names and groups, label names and campaign titles and descriptions are always redacted (those tools have no switch). The tests cover names, an event's internal title, country and description, a form name and group, a label name, campaign descriptions and Gecko's error messages.
- Tokens never appear in tool output or error messages: every error message is checked against every token the server has held, including the Access, ID and Refresh tokens each refresh returns, and a match is replaced with `[redacted]`. From an error response only Gecko's JSON message fields (`message`, `details`, `messages`, `errors`) are passed on. A non-JSON body, such as a gateway page, is never quoted.
- IDs are checked before any call is made. Every ID on the endpoints used here is an integer in the spec, so tools take positive whole numbers. The one exception is `get_contact`, which, like `GET /contacts/{id}`, also takes the contact's 26-character ULID. Stats dates must be real `YYYY-MM-DD` dates with `from` not after `to`, and `list_attendances` needs an event or a contact ID. Free-text filters are trimmed, and one that is empty or only spaces is refused. A form group that starts with `@` and contains `|` is refused, because Gecko would read it as several groups.
- Gecko documents no rate limit and no 429 response. Requests are spaced 250 ms apart (about four per second). A 429 is retried at most twice for any method, on the assumption that a rate-limited request was not processed, waiting for `Retry-After` (whole or fractional seconds, or an HTTP-date; 2 s then 4 s when the header is absent or unreadable). Each wait is capped at 10 seconds, so one request waits at most 20 seconds in all. A tool call that makes several requests (pages, lookups) can still run past the MCP client's default 60-second request timeout. If Gecko asks for a wait longer than the cap, the call gives up at once and the message says how long to wait.
- 502, 503 and 504 are retried the same way for `GET` requests to the API only. When all three attempts fail, the error says the service may be unavailable and to try again in a few minutes. A `POST` is never retried after a gateway error, because it may already have been processed; the error says to check with the matching list or get tool first. The token refresh is never retried after a gateway error either: the Refresh token is single-use, and the refresh may already have happened.
- A 200 whose body is not JSON (a proxy or a login page in the way) is reported as an error naming `GECKO_BASE_URL`, never as an empty list. A 401 says which variables to fix and where tokens come from, a spent or expired Refresh token says to create a new API token, a 403 says to check the token's scopes with `whoami`, and a 404 includes Gecko's message.
- Lists are paged with the documented `page` and `per_page` (50 per page by default, at most 100; the spec documents no maximum). A call fetches up to `max_pages` pages (4 by default) and stops at the documented end, `current_page` reaching `last_page`, or at an empty page. Pages are always returned whole. When more remain, the result says `complete: false` with the `next_page` to continue from.

## Tests

```bash
npm test
```

The test suite:

1. Validates every fixture record against the component schemas in Gecko's published OpenAPI document (`Events_EventObject`, `Attendances_Attendance`, `Contacts_Contact` including included current values, `Forms_Form`, `Responses_Response`, `Labels_Label`, `Campaigns_Campaign`, `Campaigns_CampaignStatsResponse`, `Auth_UserSummary`, `Auth_AuthScope`) with Ajv and ajv-formats. OpenAPI 3.0's `nullable` is rewritten as a JSON Schema union first. A negative control checks that a wrong type is still rejected. The spec is downloaded from `docs.geckoengage.com/openapi/engage-openapi.yml` to `spec.yaml` on the first run.
2. Starts a local mock of the API and of the refresh endpoint that serves those fixtures with the documented Laravel-style pagination (`current_page`, `last_page`, `per_page`, `total`; every page capped at 10 so the suite pages) and the documented filters, including the `@a|b` multi-value syntax and the comma-separated `category_id`. It checks Bearer tokens (a 401 in the documented shape for a token it did not issue), refreshes single-use Refresh tokens, returns 404s with the spec's example messages, and answers the first `GET /forms` with a 429. It follows the documented defaults the tools depend on: event `tags` only with `event_rfields=tags`, response `label_ids` only with `response_rfields=label_ids`, responses to application-module forms only with `module=application`, and soft-deleted attendances only with `trashed=1`. The stats range echoes the `from` and `to` it received. The mock's list, detail, write and error responses (200, 400, 401, 404) are validated against the response schemas the spec names for each operation. The request bodies it accepts are validated against the documented request schemas (the spec's own `POST /attendances` example among them). The refresh endpoint is not in the spec: its response is checked against a schema written from the guide's example refresh response, which the schema also accepts.
3. Starts the built server and drives it over stdio with the official MCP client: 30 checks (32 in the whole suite, about 50 seconds). They cover:
   - tools/list and annotations, and every tool.
   - Each documented filter passed through exactly; paging 1, 2, 3 to `last_page` with requests at least about 250 ms apart; stopping at the default of 4 pages and continuing from `next_page`; an empty page ending a list; the search body repeated on every page; application-module responses left out without `module=application` and returned with it; the stats range sent with its end-of-day time.
   - Names without contact details by default and emails on request; payment fields and personal links never returned; contact fields not requested by default, and returned on request except the bank and card fields; emails and phone numbers in names, an internal title, a country, a description, a form name and group, a label name and campaign descriptions (including the `+44 (0)`, bracketed, `00`-prefixed and dot-separated phone forms) redacted.
   - The search and the two write bodies validated against the documented request schemas, with every key a documented property; an existing booking, and a soft-deleted one, refused without a `POST`; an existing label and an unknown label causing no `POST`.
   - IDs, a `per_page` above 100, impossible dates, reversed ranges, blank keywords and a group in the multi-value syntax refused before any request; keywords trimmed; the 404 and 403 messages.
   - The 429 retry in the seconds, fractional-seconds and HTTP-date forms and the 2 s then 4 s fallback without the header; giving up after three attempts, and at once above the cap; a wait of exactly the 10 s cap honoured; a 502 retried for `GET`; three 503s reported without the gateway page; a 502 on `POST` never retried and a 429 on `POST` retried once; a non-JSON 200 reported as an error; error bodies in all three documented shapes (`message`/`details`, `messages`, `errors`) passed on redacted, including a 400 that echoes the token and a contact's email and phone.
   - Tokens:
     - A token near expiry refreshed before the call with the Refresh token as Bearer, the new token reused, the warning written to stderr without any token, and an error echoing the new tokens scrubbed.
     - A spent Refresh token after a "restart" refused with instructions and no API call.
     - A revoked token refreshed once and the call retried; revoked again on the same server, the second refresh uses the Refresh token the first one returned, never the spent one.
     - A 401 that persists after a refresh reported after exactly one refresh.
     - A 429 from the refresh endpoint retried with the same Refresh token.
     - Three concurrent calls sharing one refresh.
     - An expired Access token without a Refresh token, and an expired Refresh token, reported without a request.
     - A wrong token (pasted with `Bearer `) giving an actionable 401.
     - A 502 from the refresh endpoint not retried.
     - The region-to-host mapping.
     - Start-up refused for a missing or unknown region, an unreadable token, no token, or a username and password in `GECKO_BASE_URL` or `GECKO_TOKEN_URL` (without repeating the password).
   - The write gate with the variable unset and `false`.
   - That every request carried a token the mock issued (or the one deliberately wrong token) to a documented method and path with only documented query parameters, that the refresh used a Refresh token, and that the only `POST`s were the search and the two writes.

Test tokens are unsigned JWT-shaped values built at run time from JSON, with markers like `gecko-test-access-1-not-real`. No token-like string is stored in the repository.

## Status

This is a working prototype. It has **not yet been run against the live API**, because it was built without a Gecko account: no public trial or sandbox was found, and Gecko sells through demos. Everything below is taken from the published spec and authentication guide and should be confirmed on a real account:

- **Tokens.** That the Access token carries `exp` and a `region` claim with the values `eu`, `us-e` or `ca`, as the guide says.
- **Token refresh.** That `GET /tokens/refresh` answers with `AccessToken`, `IdToken` and `RefreshToken` as in the guide's example; the example's `ExpiresIn` looks like a Unix time rather than a duration, and the server ignores it and reads `exp` from the token instead. Also what status and body it returns for a spent or expired Refresh token (undocumented; the mock uses 401 with a `message`).
- **Expired tokens.** That an expired Access token gets a 401 from the API; the spec documents 401 for "authentication is required or the supplied token is invalid".
- **Paging.** The largest `per_page` the API accepts and what it does above it (the spec gives a minimum of 1 and no maximum; the server asks for 50 by default and at most 100). That `last_page` is present on every list, as the collection schemas require.
- **Sort order.** The default sort order of every list; the server returns whatever order the API uses.
- **Filter semantics.** How `keyword` on events, forms, labels and campaigns, and `response_keyword` on responses, match. Whether `email` on `POST /contacts/search` is an exact or partial match (the spec types it as a string without saying). Whether several `status`, `type`, `delivery_method`, `module`, `form_id`, `label` and `contact_id` values really combine as "any of" with the `@a|b` syntax, while `category_id` is comma-separated as documented.
- **Counts.** That `counts=attendances,responses` on events, `counts=responses` on forms, `counts=subscribers` on campaigns and `counts=attendances,responses` on contacts add `attendances_count`, `responses_count` and `subscribers_count` fields, as the schemas and the events list example suggest. Whether a form's response count includes responses that `GET /responses` leaves out by default (application-module and quarantined ones); the mock counts them all.
- **Extra fields.** That `event_rfields=tags` adds `tags` to events and `response_rfields=label_ids` adds `label_ids` to responses, as the parameter descriptions say.
- **Contact fields.** The shape of `current_values` with `include=current_values.field`: the server shows each value's `safe` text (falling back to `value`) under its field's `label`, as in the spec's example. The bank and card filter works on field labels, tags and types. Whether an account's real field names are caught by it needs checking, and a field named differently would be returned with `include_contact_details`.
- **`POST /attendances`.** What "create or update" does with a soft-deleted attendance (the tool refuses in that case, so this is not exercised). Whether a booking made through the API sends the event's confirmation email or runs its workflows (not documented). That `status: "yes"` creates a Registered (10) attendance and `"waitlist"` a Waitlisted (50) one. The capacity and guest-count errors, which the spec documents only by the example "Guest count must not be negative.".
- **`POST /contacts/{id}/replace_labels`.** That it accepts a plain list of existing label IDs; the spec says "Items may be existing label IDs or label objects".
- **`GET /campaigns/{id}/stats`.** What it answers for a campaign that is not a WhatsApp broadcast; the spec documents the endpoint for WhatsApp only. That `from` and `to` sent as `YYYY-MM-DD HH:MM:SS` strings are accepted ("a parseable date/time string"), and in which timezone they are read (the example response carries a `timezone`); if it is UTC, the edges of the range can be off by the account's UTC offset.
- **Error wording.** The wording of Gecko's error messages, and whether any of them echo request data; the server redacts and scrubs them regardless.
- **Rate limits.** How many requests per second the API tolerates; nothing is documented, so the 250 ms spacing is a guess on the polite side.

## Going to production

This version runs locally over stdio with a token the user creates by hand. It keeps rotated tokens in memory, so a restart needs a new API token. For admissions teams to connect from claude.ai or ChatGPT without handling tokens, the next step is a remote server (Streamable HTTP) behind OAuth, hosted by Gecko, so each user's own permissions apply. Tokens would be stored in a secret store between refreshes, as the guide suggests. After that comes a listing in the Claude and ChatGPT connector directories. Further write tools (updating a booking's status after check-in, working with conversations) can follow once they can be tested on a real account.

## Licence

MIT. Built by Alexandru Dragoș (alexandru.dragos96@gmail.com) with an AI agent (Claude) working under his direction.
