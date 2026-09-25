// Mock Freshservice — stands in for the real public v2 Ticket API so the
// tool is runnable and demoable with zero credentials. Mirrors the same
// three routes freshserviceClient.js calls in real mode:
//   POST /api/v2/tickets
//   PUT  /api/v2/tickets/:id
//   GET  /api/v2/tickets/:id
//
// Plus a couple of mock-only debug/control endpoints (clearly namespaced
// under /mock/, not part of the real API) for inspecting state and forcing
// an "agent resolves it" moment during a live demo instead of waiting on a
// timer.
//
// Run: npm run mock-server   (defaults to http://localhost:4001)

const express = require('express');

const PORT = process.env.MOCK_SERVER_PORT || 4001;
const AUTO_RESOLVE_APPROVAL_AFTER_MS = Number(process.env.MOCK_AUTO_RESOLVE_MS || 20000);

const OPEN = 2;
const RESOLVED = 4;

const app = express();
app.use(express.json());

let nextId = 1000;
const tickets = new Map();

app.post('/api/v2/tickets', (req, res) => {
  const { subject, description, email, priority, status, type, tags, group_id } = req.body || {};

  if (!subject) {
    return res.status(400).json({ errors: [{ field: 'subject', message: "can't be blank" }] });
  }
  if (!email) {
    return res.status(400).json({ errors: [{ field: 'email', message: "can't be blank" }] });
  }

  const id = nextId++;
  const ticket = {
    id,
    subject,
    description,
    email,
    priority: priority || 1,
    status: status || OPEN,
    type: type || 'Incident',
    tags: tags || [],
    group_id: group_id || null,
    created_at: new Date().toISOString(),
  };

  tickets.set(id, ticket);
  console.log(`[mock] POST /api/v2/tickets — created #${id} — "${subject}" (status ${ticket.status})`);

  if (!group_id && ticket.status !== RESOLVED) {
    // Needs-approval ticket with nobody watching it in this mock — auto-resolve
    // after a delay so the polling/notification path is still testable without
    // a human in the loop, unless you hit the manual trigger below first.
    setTimeout(() => {
      const t = tickets.get(id);
      if (t && t.status !== RESOLVED) {
        t.status = RESOLVED;
        console.log(`[mock] ticket #${id} resolved (simulated approval timer)`);
      }
    }, AUTO_RESOLVE_APPROVAL_AFTER_MS);
  } else if (group_id) {
    console.log(
      `[mock] ticket #${id} left OPEN, assigned to group ${group_id} — awaiting approval` +
        ` (auto-resolves in ${AUTO_RESOLVE_APPROVAL_AFTER_MS}ms unless you POST /mock/tickets/${id}/resolve first)`
    );
    setTimeout(() => {
      const t = tickets.get(id);
      if (t && t.status !== RESOLVED) {
        t.status = RESOLVED;
        console.log(`[mock] ticket #${id} resolved (simulated approval timer)`);
      }
    }, AUTO_RESOLVE_APPROVAL_AFTER_MS);
  }

  res.status(201).json({ ticket });
});

app.get('/api/v2/tickets/:id', (req, res) => {
  const ticket = tickets.get(Number(req.params.id));
  if (!ticket) return res.status(404).json({ errors: [{ field: 'id', message: 'not found' }] });
  res.json({ ticket });
});

app.put('/api/v2/tickets/:id', (req, res) => {
  const ticket = tickets.get(Number(req.params.id));
  if (!ticket) return res.status(404).json({ errors: [{ field: 'id', message: 'not found' }] });
  Object.assign(ticket, req.body || {});
  console.log(`[mock] PUT /api/v2/tickets/${ticket.id} — status now ${ticket.status}`);
  res.json({ ticket });
});

// --- mock-only debug/control endpoints (not part of the real API) ---

app.post('/mock/tickets/:id/resolve', (req, res) => {
  const ticket = tickets.get(Number(req.params.id));
  if (!ticket) return res.status(404).json({ errors: [{ field: 'id', message: 'not found' }] });
  ticket.status = RESOLVED;
  console.log(`[mock] ticket #${ticket.id} manually resolved`);
  res.json({ ticket });
});

app.get('/mock/tickets', (_req, res) => {
  res.json({ tickets: Array.from(tickets.values()) });
});

app.listen(PORT, () => {
  console.log(`[mock] Tally mock server listening on http://localhost:${PORT} (mirrors /api/v2/tickets)`);
});
