const { loadEnv } = require('./loadEnv');

loadEnv();

function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  mode: process.env.MODE || 'mock', // 'mock' | 'freshservice'

  mock: {
    ingestionUrl: process.env.TALLY_INGESTION_URL || 'http://localhost:4001',
  },

  freshservice: {
    domain: process.env.FRESHSERVICE_DOMAIN || '',
    apiKey: process.env.FRESHSERVICE_API_KEY || '',
    approvalGroupId: process.env.FRESHSERVICE_GROUP_ID_FOR_APPROVAL || '',
    // Public Ticket API requires a requester (email/requester_id/phone) —
    // there's no "system user" concept to fall back on outside an internal
    // Rails context, so this has to be a real, explicit value.
    requesterEmail: process.env.FRESHSERVICE_REQUESTER_EMAIL || '',
    ticketType: process.env.FRESHSERVICE_TICKET_TYPE || 'Incident',
  },

  pattern: {
    thresholdCount: num('FLAP_THRESHOLD_COUNT', 2),
    thresholdWindowMs: num('FLAP_THRESHOLD_WINDOW_MS', 5 * 60 * 1000),
  },

  capture: {
    pollIntervalMs: num('WIFI_POLL_INTERVAL_MS', 1500),
  },

  appCrash: {
    // Substring match against the full command line (pgrep -f) — safe
    // default targets VS Code, since Electron apps don't always run under
    // their display name as the literal process name.
    matchPattern: process.env.APP_CRASH_MATCH_PATTERN || 'Visual Studio Code',
  },

  listener: {
    pollIntervalMs: num('POLL_TICKET_STATUS_INTERVAL_MS', 4000),
  },
};

module.exports = config;
