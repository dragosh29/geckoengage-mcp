// Turn Gecko Engage API records into compact objects an assistant can read quickly.
// Field names follow the schemas in Gecko's OpenAPI spec (Events_EventObject, Attendances_Attendance,
// Forms_Form, Responses_Response, Contacts_Contact, Labels_Label, Campaigns_Campaign,
// Campaigns_CampaignStatsData, Auth_UserSummary, Auth_AuthScope).
//
// Gecko's contacts are prospective students, many of them under 18. By default a person is shown by
// ID and name only; emails, contact fields (which hold phone numbers, addresses, dates of birth,
// schools and identifiers) and the like are only returned with include_contact_details. Payment data
// and the personal access links Gecko issues for a contact or a booking (portal, QR, RSVP, iCal,
// Wallet pass, video page, payment page) are never returned.

type Rec = Record<string, any>;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-number-like sequences, a heuristic (the same as the other servers in this series). Three
// shapes, digits optionally separated by a space, dot or hyphen:
//   international: "+" or "00", a 1-3 digit country code, an optional "(0)" trunk prefix, then 6-14
//     digits (+44 7700 900123, +447700900321, +44 (0)7700 900123, 0044 20 7946 0958);
//   bracketed UK area code: "(0...)" then 5-10 digits ((020) 7946 0958, (0117) 496 0000);
//   UK national: "0" then 8-10 more digits (07700 900789, 020 7946 0958, 07700.900123).
// Bounded by characters other than letters, digits, "_" and "-", so IDs, ULIDs, timestamps and
// hyphenated references are left alone. Any other 9-11 digit string starting with 0 is redacted too;
// the raw text is available with include_contact_details.
const PHONE = /(?<![\w-])(?:(?:\+|00)[ .-]?[1-9]\d{0,2}(?:[ .-]?\(0\))?(?:[ .-]?\d){6,14}|\(0\d{0,4}\)(?:[ .-]?\d){5,10}|0(?:[ .-]?\d){8,10})(?![\w-])/g;

const redactString = (text: string) => text.replace(EMAIL, "[email redacted]").replace(PHONE, "[phone redacted]");

/** Replace email addresses and phone-number-like sequences inside free text unless contact details were requested. */
export function redactContacts(text: unknown, includeContact: boolean): string | undefined {
  if (typeof text !== "string" || text === "") return undefined;
  return includeContact ? text : redactString(text);
}

const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
const num = (v: unknown) => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? undefined : n;
};
/** Gecko timestamps are Unix seconds (created_at, updated_at, deleted_at, start_date, ...). */
const unix = (v: unknown) => {
  const n = num(v);
  return n === undefined ? undefined : new Date(n * 1000).toISOString();
};
const bool = (v: unknown) => (v === undefined || v === null ? undefined : v === true || v === 1 || v === "1");

/** Event descriptions are "typically stored as HTML"; reduce them to plain text of a readable length. */
export function htmlToText(html: unknown, max = 2000): string | undefined {
  if (typeof html !== "string" || !html.trim()) return undefined;
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return text.length > max ? text.slice(0, max) + " [...]" : text || undefined;
}

// Events_EventTypeCode: 10 Event, 20 Session, 30 Session time, 90 Event (legacy record), 100 Session (legacy record).
export const EVENT_TYPES: Record<string, number> = { event: 10, session: 20, session_time: 30, legacy_event: 90, legacy_session: 100 };
const EVENT_TYPE_NAMES: Record<number, string> = { 10: "event", 20: "session", 30: "session time", 90: "event (legacy)", 100: "session (legacy)" };

export function event(e: Rec, includeContact: boolean) {
  const typeCode = num(e.type);
  return {
    id: num(e.id),
    title: redactContacts(e.title, includeContact),
    internal_title: redactContacts(e.internal_title, includeContact),
    type: typeCode !== undefined ? EVENT_TYPE_NAMES[typeCode] ?? `type ${typeCode}` : undefined,
    parent_id: num(e.parent_id),
    // Spec: start_datetime/end_datetime/closing_datetime are "Y-m-d H:i:s" in the event's timezone.
    start: str(e.start_datetime),
    end: str(e.end_datetime),
    registration_closes: str(e.closing_datetime),
    timezone: str(e.timezone),
    status: str(e.status),
    delivery_method: str(e.delivery_method),
    country: redactContacts(e.country, includeContact),
    cost: num(e.cost),
    maximum: num(e.maximum),
    maximum_waitlist: num(e.maximum_waitlist),
    location_id: str(e.location_id),
    // Present when requested with event_rfields=tags.
    tags: Array.isArray(e.tags) && e.tags.length ? e.tags.map((t: unknown) => redactContacts(t, includeContact)) : undefined,
    // Present when requested with counts=attendances,responses.
    attendances: num(e.attendances_count),
    responses: num(e.responses_count),
    deleted: e.deleted_at ? unix(e.deleted_at) : undefined,
  };
}

export function eventDetail(e: Rec, includeContact: boolean) {
  return {
    ...event(e, includeContact),
    description: redactContacts(htmlToText(e.description), includeContact),
    maximum_guests: num(e.maximum_guests),
    auto_waitlist: e.auto_waitlist,
    location: e.location && typeof e.location === "object" ? { id: str(e.location.id), title: redactContacts(e.location.title, includeContact) } : undefined,
    categories: Array.isArray(e.categories) ? e.categories.map((c: Rec) => ({ id: num(c.id), title: redactContacts(c.title, includeContact) })) : undefined,
    // Events_EventRelationSummary for sessions and session times.
    sessions: Array.isArray(e.children)
      ? e.children.map((c: Rec) => ({
          id: num(c.id),
          title: redactContacts(c.title, includeContact),
          type: num(c.type) !== undefined ? EVENT_TYPE_NAMES[num(c.type) as number] ?? `type ${c.type}` : undefined,
          start: str(c.start_datetime),
          end: str(c.end_datetime),
          delivery_method: str(c.delivery_method),
        }))
      : undefined,
    created: unix(e.created_at),
    updated: unix(e.updated_at),
  };
}

// Attendances_AttendanceStatus: 10 Registered, 20 Invited, 30 Attended, 40 Engaged, 50 Waitlisted,
// 80 Removed, 90 Cancelled, 100 Did not attend.
export const ATTENDANCE_STATUSES: Record<string, number> = { registered: 10, invited: 20, attended: 30, engaged: 40, waitlisted: 50, removed: 80, cancelled: 90, did_not_attend: 100 };
const ATTENDANCE_STATUS_NAMES: Record<number, string> = { 10: "Registered", 20: "Invited", 30: "Attended", 40: "Engaged", 50: "Waitlisted", 80: "Removed", 90: "Cancelled", 100: "Did not attend" };

// Attendances_Attendance. Never returned: payment_status, payment_transaction_id, payment_url,
// payment_response_id, and the attendee's personal links (rsvp, ical, passbook, video_page, and the
// contact's qr_url), which open that student's booking without signing in.
export function attendance(a: Rec, includeContact: boolean) {
  const status = num(a.status);
  const c = a.contact && typeof a.contact === "object" ? a.contact : undefined;
  const ev = a.event && typeof a.event === "object" ? a.event : undefined;
  return {
    id: num(a.id),
    contact_id: num(a.contact_id),
    name: c ? redactContacts(c.full_name, includeContact) : undefined,
    ...(includeContact && c ? { email: str(c.email) } : {}),
    event_id: num(a.event_id),
    event: ev ? { title: redactContacts(ev.title, includeContact), start: str(ev.start_datetime) } : undefined,
    status: str(a.status_title) ?? (status !== undefined ? ATTENDANCE_STATUS_NAMES[status] ?? `status ${status}` : undefined),
    status_code: status,
    guest_count: num(a.guest_count),
    booked: unix(a.created_at),
    updated: unix(a.updated_at),
  };
}

export function form(f: Rec) {
  return {
    id: num(f.id),
    name: redactContacts(f.name, false),
    internal_name: redactContacts(f.internal_name, false),
    module: str(f.module),
    group: redactContacts(f.group, false),
    published: bool(f.published),
    expired: f.expired,
    full: f.full,
    max_responses: num(f.max_responses),
    // Present when requested with counts=responses.
    responses: num(f.responses_count),
    created: unix(f.created_at),
    updated: unix(f.updated_at),
  };
}

// Responses_Response.status: "Draft responses commonly return 10 and completed responses return 20."
const RESPONSE_STATUS: Record<number, string> = { 10: "draft", 20: "completed" };

// Responses_Response. The answers themselves (`values`) are not requested; the email stored on the
// response is only returned with include_contact_details.
export function response(r: Rec, includeContact: boolean) {
  const status = num(r.status);
  return {
    id: num(r.id),
    form_id: num(r.form_id),
    contact_id: num(r.contact_id),
    ...(includeContact ? { email: str(r.email) } : {}),
    status: status !== undefined ? RESPONSE_STATUS[status] ?? `status ${status}` : undefined,
    assigned_user_id: num(r.assigned_id),
    labels: Array.isArray(r.labels) && r.labels.length ? r.labels.map((l: Rec) => redactContacts(l.name, includeContact) ?? `label ${l.id}`) : undefined,
    // Present when requested with response_rfields=label_ids.
    label_ids: Array.isArray(r.label_ids) && r.label_ids.length ? r.label_ids : undefined,
    submitted: unix(r.created_at),
    updated: unix(r.updated_at),
  };
}

const labelRef = (l: Rec, includeContact: boolean) => ({ id: num(l.id), name: redactContacts(l.name, includeContact) });

// Contacts_Contact. Never returned: portal_url, qr_url, short_qr_url and events_page (links into the
// student's own portal) and available_auth_methods (masked sign-in addresses).
export function contactSummary(c: Rec, includeContact: boolean) {
  return {
    id: num(c.id),
    contact_ulid: str(c.contactId),
    name: redactContacts(c.full_name, includeContact),
    ...(includeContact ? { email: str(c.email) } : {}),
    preferred_language: str(c.preferred_language),
    responses: num(c.number_responses),
    labels: Array.isArray(c.labels) ? c.labels.map((l: Rec) => labelRef(l, includeContact)) : undefined,
  };
}

// Contact fields whose label, tag or type looks like bank, card or payment data are never returned,
// even with include_contact_details.
const FINANCIAL = /\b(bank|iban|bic|swift|sort[\s_-]*code|account[\s_-]*(no|num|number)|card|cvv|cvc|payment|pay[\s_-]*ref|expiry)\b/i;
const isFinancial = (f: Rec) => [f?.label, f?.tag, f?.type].some((x) => typeof x === "string" && FINANCIAL.test(x.replace(/_/g, " ")));

/** A contact's current field values (include=current_values.field): label and the display value. */
export function contactFields(values: unknown, includeContact: boolean) {
  const list = Array.isArray(values) ? (values as Rec[]) : [];
  const safe = list.filter((v) => !isFinancial(v.field));
  const withheldAlways = list.length - safe.length;
  if (!includeContact) {
    return { fields: undefined, fields_withheld: safe.length || undefined, financial_fields_never_returned: withheldAlways || undefined };
  }
  const fields = safe.map((v) => {
    const f = v.field && typeof v.field === "object" ? v.field : {};
    const value = typeof v.safe === "string" ? v.safe : typeof v.value === "string" || typeof v.value === "number" ? String(v.value) : v.value !== undefined && v.value !== null ? JSON.stringify(v.value) : undefined;
    return { label: str(f.label) ?? str(f.tag) ?? `field ${v.field_id}`, type: str(f.type), value, sensitive: f.is_sensitive ? true : undefined, updated: unix(v.updated_at) };
  });
  return { fields, fields_withheld: undefined, financial_fields_never_returned: withheldAlways || undefined };
}

export function contactDetail(c: Rec, includeContact: boolean) {
  return {
    ...contactSummary(c, includeContact),
    // Present when requested with counts=attendances,responses.
    attendances: num(c.attendances_count),
    responses_count: num(c.responses_count),
    ...contactFields(c.current_values, includeContact),
  };
}

export function label(l: Rec) {
  return { id: num(l.id), name: redactContacts(l.name, false), color: str(l.color), ai_generated: l.ai_generated };
}

// Campaigns_CampaignStatus: 10 Pending, 20 Active, 25 Running, 30 Complete, 40 Paused, 50 Cancelled, 100 Invalid.
export const CAMPAIGN_STATUSES: Record<string, number> = { pending: 10, active: 20, running: 25, complete: 30, paused: 40, cancelled: 50, invalid: 100 };

export function campaign(c: Rec) {
  return {
    id: num(c.id),
    title: redactContacts(c.title, false),
    description: redactContacts(c.description, false),
    module: str(c.module),
    status: str(c.status_title),
    status_code: num(c.status),
    starts: unix(c.start_date),
    ends: unix(c.end_date),
    // Present when requested with counts=subscribers.
    subscribers: num(c.subscribers_count),
    created: unix(c.created_at),
  };
}

// Campaigns_CampaignStatsData: range, summary, open_rate and delivery_performance buckets.
export function campaignStats(s: Rec) {
  const summary = s?.summary ?? {};
  const bucket = (b: Rec) => ({
    period: str(b.period),
    total: num(b.total_messages),
    attempted: num(b.attempted_messages),
    delivered: num(b.delivered_messages),
    read: num(b.read_messages),
    open_rate_percent: num(b.open_rate),
    delivery_rate_percent: num(b.delivery_rate),
    failed: num(b.failed),
    undelivered: num(b.undelivered),
  });
  return {
    campaign_id: num(s?.campaign_id),
    range: s?.range ? { from: str(s.range.from), to: str(s.range.to), group: str(s.range.group), timezone: str(s.range.timezone) } : undefined,
    summary: {
      total_messages: num(summary.total_messages),
      attempted: num(summary.attempted_messages),
      delivered: num(summary.delivered_messages),
      read: num(summary.read_messages),
      open_rate_percent: num(summary.open_rate),
      delivery_rate_percent: num(summary.delivery_rate),
    },
    periods: Array.isArray(s?.delivery_performance) ? s.delivery_performance.map(bucket) : Array.isArray(s?.open_rate) ? s.open_rate.map(bucket) : [],
  };
}

export function user(u: Rec, includeContact: boolean) {
  return {
    id: num(u.id),
    name: redactContacts(u.full_name, includeContact),
    ...(includeContact ? { email: str(u.email) } : {}),
  };
}

export function scopes(list: unknown) {
  const items = Array.isArray(list) ? (list as Rec[]) : [];
  return {
    available: items.filter((s) => s.available === true).map((s) => str(s.key)).filter(Boolean),
    unavailable: items.filter((s) => s.available !== true).map((s) => str(s.key)).filter(Boolean),
  };
}
