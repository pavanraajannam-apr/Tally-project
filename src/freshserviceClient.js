// Freshservice client — talks to the STANDARD public v2 Ticket API only.
// No custom itildesk route/controller/service is needed for this anymore —
// just a domain + API key in .env, same as any external integration would
// use:
//   POST /api/v2/tickets            create a ticket
//   PUT  /api/v2/tickets/:id        update a ticket (used to resolve it)
//   GET  /api/v2/tickets/:id        poll ticket status
//
// Mock mode hits the bundled mock-server, which mirrors these same three
// routes under the same /api/v2 paths, so the rest of the tool never has to
// know which mode it's running in.

const config = require('./config');

function basicAuthHeader(apiKey) {
  const token = Buffer.from(`${apiKey}:X`).toString('base64');
  return `Basic ${token}`;
}

function baseUrl() {
  return config.mode === 'freshservice'
    ? `https://${config.freshservice.domain}/api/v2`
    : `${config.mock.ingestionUrl}/api/v2`;
}

function authHeaders() {
  if (config.mode !== 'freshservice') return {}; // mock mode — no credentials needed
  return { Authorization: basicAuthHeader(config.freshservice.apiKey) };
}

function assertFreshserviceConfigured() {
  const { domain, apiKey, requesterEmail } = config.freshservice;
  if (!domain || !apiKey) {
    throw new Error('MODE=freshservice requires FRESHSERVICE_DOMAIN and FRESHSERVICE_API_KEY in .env');
  }
  if (!requesterEmail) {
    throw new Error(
      'MODE=freshservice requires FRESHSERVICE_REQUESTER_EMAIL in .env — the public Ticket API ' +
        'needs a real requester (email/requester_id/phone), there is no "system user" fallback outside Rails.'
    );
  }
}

function normalizeTicket(raw) {
  // Public API only returns `id` (no separate display_id like the internal
  // Rails model has) — expose both field names anyway so the rest of the
  // tool (notifier/listener logging) doesn't need to change.
  return { id: raw.id, display_id: raw.id, status: raw.status };
}

async function request(method, path, body) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

// Creates a ticket via POST /api/v2/tickets with the fields relevant to a
// Tally-filed ticket: subject, description (RCA writeup), requester email,
// priority, status, type, tags, and — on the needs-approval path —
// group_id. `auto_fixable`/`resolution_note` are NOT sent to Freshservice;
// resolving happens as a separate explicit update (see resolveTicket)
// rather than something the API has to interpret.
async function createTicket(payload) {
  if (config.mode === 'freshservice') assertFreshserviceConfigured();

  const body = {
    subject: payload.subject,
    description: payload.description,
    email: config.mode === 'freshservice' ? config.freshservice.requesterEmail : (payload.email || 'tally-agent@mock.local'),
    priority: payload.priority || 1, // 1=Low, 2=Medium, 3=High, 4=Urgent
    status: payload.status || 2, // 2=Open, 3=Pending, 4=Resolved, 5=Closed
    type: config.freshservice.ticketType,
    tags: payload.tags || ['tally'],
    ...(payload.group_id ? { group_id: payload.group_id } : {}),
  };

  const { ticket } = await request('POST', '/tickets', body);
  return { ticket: normalizeTicket(ticket) };
}

// Moves a ticket to Resolved via PUT /api/v2/tickets/:id — used right after
// creation on the auto-fixable path.
//
// `resolutionNotes` is sent as the standard `resolution_notes` field on the
// same PUT. Some Freshservice accounts (confirmed on the real demo account)
// have a business rule making a resolution note mandatory to resolve/close
// a ticket at all — omitting it fails with a 400 "Business Rules Violated -
// Resolution Note is required" — so this is sent unconditionally, not just
// when required, since a resolved ticket with no resolution note is a bad
// practice regardless.
async function resolveTicket(ticketId, { status = 4, resolutionNotes } = {}) {
  const body = { status };
  if (resolutionNotes) body.resolution_notes = resolutionNotes;
  const { ticket } = await request('PUT', `/tickets/${ticketId}`, body);
  return { ticket: normalizeTicket(ticket) };
}

// Polls ticket status via GET /api/v2/tickets/:id.
async function getTicketStatus(ticketId) {
  const { ticket } = await request('GET', `/tickets/${ticketId}`);
  return ticket.status;
}

module.exports = { createTicket, resolveTicket, getTicketStatus };
