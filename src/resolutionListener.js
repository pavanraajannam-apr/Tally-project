// Resolution listener — the Tally tool flips into this mode right after
// filing a ticket. Polls the ticket via the Freshservice client (real API
// or mock) and fires the OS notification the instant it sees Resolved.

const { getTicketStatus } = require('./freshserviceClient');
const { notifyResolved } = require('./notifier');
const config = require('./config');

// Ticket::TicketField::TicketStatus::RESOLVED in itildesk (components/ticket/
// lib/ticket/ticket_field/ticket_status.rb) — also true for the mock server.
const RESOLVED_STATUS = 4;

function watchForResolution({ ticket, diagnosis }) {
  const intervalMs = config.listener.pollIntervalMs;

  console.log(
    `[listener] watching ticket #${ticket.display_id} for resolution (polling every ${intervalMs}ms)`
  );

  const timer = setInterval(async () => {
    try {
      const status = await getTicketStatus(ticket.id);
      if (status === RESOLVED_STATUS) {
        clearInterval(timer);
        console.log(`[listener] ticket #${ticket.display_id} resolved — notifying`);
        notifyResolved({
          ticketDisplayId: ticket.display_id,
          cause: diagnosis.description,
          fix: diagnosis.fix,
        });
      }
    } catch (err) {
      console.error('[listener] poll failed:', err.message);
    }
  }, intervalMs);

  return () => clearInterval(timer);
}

module.exports = { watchForResolution, RESOLVED_STATUS };
