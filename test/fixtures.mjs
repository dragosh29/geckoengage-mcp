// Fake Gecko Engage data shaped like the schemas in the published OpenAPI spec (validated in e2e.mjs).
// Names, addresses and numbers are invented; emails use example.com / example.ac.uk, phone numbers the
// Ofcom drama ranges (07700 900xxx, 0117 496 0xxx). IDs are small, obviously fake numbers, and the
// ULIDs are low-entropy placeholders.
const T0 = 1788000000; // Unix seconds, late August 2026
const ulid = (n) => `01TESTCONTACT${String(n).padStart(13, "0")}`; // 26 characters
export const auth = {
  user: { id: 7, auth_id: "2yUS00000000000000000000test", email: "api.user@example.ac.uk", full_name: "Admissions API User", abilities: { responses_view: { can: true, reason: null } } },
  scopes: [
    { key: "events_view", name: "View Events", description: "View events.", ability: "events:view", method: "GET", group: "events", available: true, unavailableReason: null },
    { key: "contacts_view", name: "View Contacts", description: "View contacts.", ability: "contacts:view", method: "GET", group: "contacts", available: true, unavailableReason: null },
    { key: "users_delete", name: "Delete Users", description: "Delete user records.", ability: "users:delete", method: "DELETE", group: "users", available: false, unavailableReason: "Your account does not have the required permission." },
  ],
};

// ---- Labels (Labels_Label) ----
export const labels = [
  { id: 1, account_id: 1, name: "Prospect", color: "#FF0000", ai_generated: false, ai_available: false, created_at: T0, updated_at: T0, deleted_at: null },
  { id: 2, account_id: 1, name: "Open day 2026", color: "#00AA55", ai_generated: false, ai_available: true, created_at: T0, updated_at: T0, deleted_at: null },
  { id: 3, account_id: 1, name: "Scholarship interest", color: "#0055AA", ai_generated: false, ai_available: false, created_at: T0, updated_at: T0, deleted_at: null },
  // A label name with a phone number typed into it, to prove label names are redacted.
  { id: 4, account_id: 1, name: "Call back (0117 496 0123)", color: "#AAAAAA", ai_generated: false, ai_available: false, created_at: T0, updated_at: T0, deleted_at: null },
];
const labelRef = (id) => {
  const l = labels.find((x) => x.id === id);
  return { id: l.id, name: l.name, color: l.color };
};

// ---- Events (Events_EventObject) ----
const baseEvent = (id, title, extra = {}) => ({
  id,
  account_id: 1,
  user_id: 7,
  parent_id: null,
  title,
  internal_title: title.toLowerCase().replace(/\W+/g, "_"),
  type: 10,
  registration_type: 10,
  timezone: "Europe/London",
  start_datetime: "2026-10-17 09:00:00",
  end_datetime: "2026-10-17 16:00:00",
  closing_datetime: null,
  country: "United Kingdom",
  cost: 0,
  description: null,
  location_id: "2vLO0000000000000000000001",
  delivery_method: "venue",
  maximum: 200,
  maximum_waitlist: 20,
  maximum_guests: 2,
  auto_waitlist: true,
  status: "future",
  tags: null,
  created_at: T0,
  updated_at: T0,
  deleted_at: null,
  ...extra,
});
export const events = [
  baseEvent(2, "Autumn Open Day", {
    registration_type: 30,
    description: "<h1>Autumn Open Day</h1><p>Tours, talks &amp; lunch.</p><p>Questions? Email admissions@example.ac.uk or call 0117 496 0000.</p>",
    tags: ["undergraduate", "campus"],
  }),
  baseEvent(21, "Campus tour (morning)", { parent_id: 2, type: 20, registration_type: null, start_datetime: "2026-10-17 10:00:00", end_datetime: "2026-10-17 11:00:00" }),
  baseEvent(22, "Subject talk: Computing", { parent_id: 2, type: 20, registration_type: null, start_datetime: "2026-10-17 11:30:00", end_datetime: "2026-10-17 12:15:00" }),
  baseEvent(3, "Spring Open Day", { internal_title: "Spring open day - owner events@example.ac.uk", start_datetime: "2027-03-13 09:00:00", end_datetime: "2027-03-13 16:00:00" }),
  baseEvent(4, "Online Q&A: Student Finance", { delivery_method: "online", location_id: null, start_datetime: "2026-10-01 18:00:00", end_datetime: "2026-10-01 19:00:00", status: "future" }),
  // A country field with an email typed into it, to prove the country is redacted.
  baseEvent(5, "Summer Open Day 2026", { start_datetime: "2026-06-20 09:00:00", end_datetime: "2026-06-20 16:00:00", status: "past", country: "United Kingdom (queries summer@example.ac.uk)" }),
];
// Category membership (the spec's `categories` include), used by the category_id filter.
export const eventCategories = { 2: [{ id: 2, title: "Open days" }], 3: [{ id: 2, title: "Open days" }], 5: [{ id: 2, title: "Open days" }], 4: [{ id: 3, title: "Webinars" }] };
export const eventLocations = { 2: { id: "2vLO0000000000000000000001", title: "Main Campus", timezone: "Europe/London" } };

// ---- Contacts (Contacts_Contact) ----
const field = (id, label, type, tag, extra = {}) => ({
  id, account_id: 1, field_type: "contact", label, type, tag, system: null, required: 0, is_sensitive: null, data_type: "string", ...extra,
});
const value = (id, contactId, f, safe) => ({ id, account_id: 1, response_id: null, contact_id: contactId, field_id: f.id, contact_field_id: f.id, varchar: safe, text: null, safe_db: safe, numeric: null, created_at: T0, updated_at: T0 + 60, deleted_at: null, field: f, has_past_values: false, modified: null, safe, value: safe });
const F = {
  email: field(101, "Email", "email", "email"),
  phone: field(102, "Mobile number", "phone", "mobile"),
  dob: field(103, "Date of birth", "date", "date_of_birth", { is_sensitive: 1 }),
  school: field(104, "Current school", "text", "school"),
  postcode: field(105, "Home postcode", "text", "postcode"),
  bank: field(106, "Bank account number", "text", "bank_account_number"),
  card: field(107, "Card number", "text", "card_number"),
  lang: field(108, "Preferred Language", "preferred_language", "preferred_language", { system: 1 }),
};
const mkContact = (id, name, email, labelIds = [], extra = {}) => ({
  id,
  contactId: ulid(id),
  uuid: `21CO${String(id).padStart(22, "0")}`,
  full_name: name,
  email,
  preferred_language: "en",
  number_responses: 1,
  portal_url: `https://portal.example.test/p/${ulid(id)}`,
  short_qr_url: `https://qr.example.test/s/${id}`,
  qr_url: `https://qr.example.test/q/${ulid(id)}`,
  events_page: `https://events.example.test/e/${ulid(id)}`,
  sync_status: 10,
  available_auth_methods: [{ type: "email", value: "st**@ex****le.com" }],
  labels: labelIds.map(labelRef),
  ...extra,
});
export const contacts = [
  mkContact(11, "Priya Shah", "priya.shah@example.com", [1, 2]),
  mkContact(12, "Sam Evans", "sam.evans@example.com", [1]),
  // A name with contact details typed into it, to prove names are redacted by default.
  mkContact(13, "Lee Chen (call 07700 900456)", "lee.chen@example.com", [3]),
  ...Array.from({ length: 23 }, (_, i) => mkContact(100 + i, `Student ${i + 1}`, `student${i + 1}@example.com`, i % 2 ? [2] : [])),
];
export const PRIYA = 11;
export const PRIYA_ULID = ulid(11);
// Current values (include=current_values.field) for Priya: contact details, a date of birth, a school,
// and two financial fields that must never be returned.
export const currentValues = {
  11: [
    value(9001, 11, F.email, "priya.shah@example.com"),
    value(9002, 11, F.phone, "07700 900123"),
    value(9003, 11, F.dob, "2009-04-02"),
    value(9004, 11, F.school, "Example Academy, Bristol"),
    value(9005, 11, F.postcode, "BS1 4ST"),
    value(9006, 11, F.bank, "12345678"),
    value(9007, 11, F.card, "4000 0000 0000 0000"),
    value(9008, 11, F.lang, "en"),
  ],
};
export const BANK_VALUE = "12345678";
export const CARD_VALUE = "4000 0000 0000 0000";

// ---- Attendances (Attendances_Attendance) ----
const STATUS_TITLES = { 10: "Registered", 20: "Invited", 30: "Attended", 40: "Engaged", 50: "Waitlisted", 80: "Removed", 90: "Cancelled", 100: "Did not attend" };
let attendanceId = 500;
export const mkAttendance = (contactId, eventId, status, extra = {}) => ({
  id: ++attendanceId,
  uuid: `2vAT${String(attendanceId).padStart(22, "0")}`,
  contact_id: contactId,
  event_id: eventId,
  status,
  status_title: STATUS_TITLES[status],
  sync_status: 10,
  guest_count: 0,
  attendances_count: 1,
  response_id: null,
  payment_response_id: null,
  payment_status: null,
  payment_transaction_id: null,
  payment_url: null,
  payment_status_updated_at: null,
  description: null,
  rsvp: `https://events.example.test/#/rsvp/2vAC0000000000000000000000/${contactId}/${eventId}`,
  ical: `https://api.example.test/attendances/ical/2vAC0000000000000000000000/${contactId}/${eventId}`,
  passbook: `https://api.example.test/attendances/passbook/2vAC0000000000000000000000/${contactId}/${eventId}`,
  video_page: `https://events.example.test/#/video/${contactId}/${eventId}`,
  created_at: T0 + attendanceId,
  updated_at: T0 + attendanceId,
  ...extra,
});
export const attendances = [
  // Priya has paid for a guest place: payment fields that must never be returned.
  mkAttendance(11, 2, 10, { guest_count: 1, payment_status: "completed", payment_transaction_id: "01TESTPAYMENT0000000000000", payment_url: "https://pay.example.test/checkout/test-not-real", payment_response_id: 301, payment_status_updated_at: T0 + 10 }),
  mkAttendance(12, 2, 30),
  mkAttendance(13, 2, 50),
  ...contacts.filter((c) => c.id >= 100).map((c, i) => mkAttendance(c.id, 2, [10, 10, 30, 90][i % 4])),
  mkAttendance(11, 4, 30),
  mkAttendance(11, 5, 100),
  // Soft-deleted (the mock returns it only with trashed=1): Sam's cancelled booking on the online Q&A.
  mkAttendance(12, 4, 90),
];
export const TRASHED_ATTENDANCE_IDS = new Set([attendances.at(-1).id]);
export const OPEN_DAY_ATTENDANCES = 26;

// ---- Forms (Forms_Form) ----
const mkForm = (id, name, module, group, published, extra = {}) => ({
  id, account_id: 1, uuid: `2vFO${String(id).padStart(22, "0")}`, code: 10000 + id, name, internal_name: name.toLowerCase().replace(/\W+/g, "-"), module, group, language: "en", published, submit_text: "Submit", expired: false, full: false, max_responses: null, created_at: T0, updated_at: T0, ...extra,
});
export const forms = [
  mkForm(31, "Open Day Registration", "event", "Events", 1),
  // A form group with contact details typed into it, to prove groups are redacted.
  mkForm(32, "Undergraduate Enquiry", "form", "Enquiries (owner jo.bloggs@example.com 07700 900555)", 1),
  mkForm(33, "Scholarship Application (queries: scholarships@example.ac.uk)", "application", "Applications", 0, { max_responses: 100 }),
];

// ---- Responses (Responses_Response) ----
const mkResponse = (id, formId, contactId, email, status, labelIds = []) => ({
  id, account_id: 1, form_id: formId, contact_id: contactId, contactId: contactId ? ulid(contactId) : null, assigned_id: null, email, status, sync_status: 10, sync_status_title: "Synced", label_ids: labelIds, created_at: T0 + id, updated_at: T0 + id,
});
export const responses = [
  mkResponse(301, 31, 11, "priya.shah@example.com", 20, [2]),
  mkResponse(302, 31, 12, "sam.evans@example.com", 20, []),
  mkResponse(303, 32, 13, "lee.chen@example.com", 20, [1]),
  mkResponse(304, 33, 11, "priya.shah@example.com", 10, [3]),
  mkResponse(305, 32, null, "anonymous@example.com", 20, []),
];
export const responseLabels = (r) => r.label_ids.map(labelRef);

// ---- Campaigns (Campaigns_Campaign) ----
const mkCampaign = (id, title, module, status, statusTitle, extra = {}) => ({
  id, account_id: 1, user_id: 7, title, module, description: null, status, status_title: statusTitle, template_id: null, filter_id: 1, form_id: null, start_date: T0, end_date: null, created_at: T0, updated_at: T0, deleted_at: null, ...extra,
});
export const campaigns = [
  mkCampaign(41, "Open day reminder", "whatsapp", 30, "Complete", { subscribers_count: 120 }),
  mkCampaign(42, "Offer holder calls", "call", 20, "Active", { subscribers_count: 45, description: "Call offer holders; escalate to 0117 496 0999" }),
  mkCampaign(43, "Clearing emails", "email", 10, "Pending", { subscribers_count: 0, description: "Hotline +44 (0)7700 900111, (020) 7946 0958, 0044 20 7946 0000 or 07700.900222" }),
];
// Campaigns_CampaignStatsData, modelled on the spec's Campaigns_CampaignStatsResponseExample. The range
// echoes the `from` and `to` received ("YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS") in the example's ISO form,
// without widening them: a bare date comes back as midnight.
const isoRange = (v) => {
  const [date, time = "00:00:00"] = String(v).split(" ");
  return `${date}T${time}+00:00`;
};
export const campaignStats = (id, fromRaw, toRaw, group) => {
  const [from, to] = [String(fromRaw).slice(0, 10), String(toRaw).slice(0, 10)];
  return {
    campaign_id: id,
    range: { from: isoRange(fromRaw), to: isoRange(toRaw), group, timezone: "Europe/London" },
    summary: { total_messages: 4, attempted_messages: 4, delivered_messages: 2, read_messages: 1, open_rate: 50, delivery_rate: 50 },
    open_rate: [
      { period: from, total_messages: 2, attempted_messages: 2, delivered_messages: 2, read_messages: 1, open_rate: 50 },
      { period: to, total_messages: 2, attempted_messages: 2, delivered_messages: 0, read_messages: 0, open_rate: 0 },
    ],
    delivery_performance: [
      { period: from, total_messages: 2, attempted_messages: 2, delivered_messages: 2, read_messages: 1, open_rate: 50, delivery_rate: 100, sending: 0, sent: 0, delivered: 1, read: 1, failed: 0, undelivered: 0, failed_to_deliver: 0 },
      { period: to, total_messages: 2, attempted_messages: 2, delivered_messages: 0, read_messages: 0, open_rate: 0, delivery_rate: 0, sending: 0, sent: 0, delivered: 0, read: 0, failed: 1, undelivered: 1, failed_to_deliver: 2 },
    ],
    // The spec requires `comparison`: a second stats set when compare_campaign_id is given, null otherwise.
    comparison: null,
  };
};
