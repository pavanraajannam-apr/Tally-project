#!/usr/bin/env node
// Tally tool — entry point. Wires capture -> pattern engine -> diagnosis ->
// policy gate -> Freshservice client -> resolution listener -> notifier.
//
// Diagnosis is scored against the REAL OS diagnostics captured per flap
// (see osDiagnostics.js / capture.js) — there is no static change-log or
// "forced cause" that decides the outcome ahead of time. In live mode the
// data comes from the actual Wi-Fi radio/DHCP state on this machine. In
// simulate mode (no real Wi-Fi hardware in this sandbox), --force-scenario
// lets you inject synthetic diagnostics that match a specific rule, purely
// so a demo/rehearsal can be steered — the scoring logic itself is identical
// either way, and if you omit --force-scenario the injected data is
// deliberately ambiguous, which is what actually happens when the real
// Wi-Fi diagnostics don't clearly match any known pattern.
//
// Usage:
//   node src/index.js                                     real Wi-Fi capture (macOS)
//   node src/index.js --simulate-flap                              inject two synthetic
//                                                                   flaps with ambiguous
//                                                                   diagnostics (LOW confidence)
//   node src/index.js --simulate-flap --force-scenario=bssid-roam        auto-fix demo
//   node src/index.js --simulate-flap --force-scenario=dhcp-lease-churn  needs-approval demo
//   node src/index.js --simulate-flap --force-scenario=weak-signal       needs-approval demo
//   node src/index.js --simulate-flap --force-scenario=rf-interference   needs-approval demo

const config = require('./config');
const { startWifiWatcher, detectWifiInterface } = require('./capture');
const { diagnose, RULES } = require('./diagnosis');
const { createPatternEngine } = require('./patternEngine');
const { createTicket, resolveTicket } = require('./freshserviceClient');
const { watchForResolution } = require('./resolutionListener');

// --- Two demo friction types, two policies ---
//
// Wi-Fi: the diagnosis engine (diagnosis.js) still runs for real against
// real captured diagnostics — no change there, still a genuine RCA, not a
// canned string. What's fixed now is the GATE rule built on top of it:
//   - diagnosis found NO known pattern (id === 'insufficient-signal') ->
//     auto-resolve. Nothing actionable was identified, so there's nothing
//     for a human to review — treated as a transient blip. This is also
//     the realistic outcome of a plain manual Wi-Fi toggle on a healthy
//     network (see the earlier live-run logs), so it's the reliable path
//     to demo with a real toggle.
//   - diagnosis found a SPECIFIC cause (bssid-roam / weak-signal /
//     dhcp-lease-churn / rf-interference) -> always needs approval. A real
//     pattern was identified, so a human should confirm/apply the proposed
//     fix rather than have the tool act on it unsupervised. Demo this with
//     any --force-scenario run.
//
// App crash: no conditional rule at all — every crash/reopen pattern always
// needs approval, full stop (there's no crash-side diagnosis engine to
// condition on; see handleAppCrashPatternDetected).
//
// (VPN was the original second scenario here, but was removed — its
// detection signal, "who owns the default route", is not independent of
// Wi-Fi: GlobalProtect's tunnel rides the Wi-Fi link, so toggling Wi-Fi
// necessarily flaps VPN too. Confirmed live: a single Wi-Fi toggle test
// filed both a Wi-Fi ticket and a VPN ticket. App-crash detection has no
// such entanglement, so it actually isolates from the Wi-Fi scenario.)
function wifiGateFor(diagnosis) {
  const autoFixable = diagnosis.id === 'insufficient-signal';
  return {
    autoFixable,
    reason: autoFixable
      ? 'No known pattern matched the captured diagnostics — policy: auto-resolve as a transient blip.'
      : `Diagnosed cause "${diagnosis.id}" — policy: a specific pattern was identified, always needs approval.`,
  };
}

const APP_CRASH_GATE = {
  autoFixable: false,
  reason: 'Application crash/force-quit — policy: always needs approval (routed to a human to check for data loss/repeat crashes).',
};

const TICKET_STATUS = { OPEN: 2, PENDING: 3, RESOLVED: 4, CLOSED: 5 };

// Freshservice's public v2 API stores whatever is sent in `description` as
// the ticket's description_html VERBATIM — no escaping, no separate
// description_html field required (confirmed against
// components/ticket/app/controllers/ticket/tickets_controller.rb's
// build_ticket_body_attributes). So real HTML here renders as real bold/
// paragraphs in the ticket, matching how it's meant to be read at a glance.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function field(label, value) {
  return `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`;
}

function buildDescriptionHtml({ diagnosis, lastDiagnostics, gate }) {
  const parts = [
    field('SAY', `Detected ${diagnosis.total} Wi-Fi flap(s) with no ticket filed.`),
    field('Diagnosed cause', diagnosis.description),
    field('Confidence', `${diagnosis.confidence} (explains ${diagnosis.explained}/${diagnosis.total} events)`),
    field('last flap', JSON.stringify(lastDiagnostics)),
    field('Proposed fix', diagnosis.fix),
  ];
  if (gate.autoFixable) {
    parts.push(field('Applied automatically', diagnosis.fix));
  }
  return parts.join('\n');
}

const SCENARIO_IDS = RULES.map((r) => r.id);

function parseArgs(argv) {
  const args = { simulateFlap: false, simulateCrashFlap: false, forceScenario: null };
  for (const arg of argv) {
    if (arg === '--simulate-flap') args.simulateFlap = true;
    if (arg === '--simulate-crash-flap') args.simulateCrashFlap = true;
    if (arg.startsWith('--force-scenario=')) args.forceScenario = arg.split('=')[1];
  }
  if (args.forceScenario && !SCENARIO_IDS.includes(args.forceScenario)) {
    console.warn(
      `[tally] unknown --force-scenario="${args.forceScenario}" — known scenarios: ${SCENARIO_IDS.join(', ')}. Ignoring.`
    );
    args.forceScenario = null;
  }
  return args;
}

// Synthetic per-flap diagnostics for simulate mode. Each scenario is built
// so that ONLY the matching rule in diagnosis.js scores above 0 for it —
// same evaluate() functions that run against real captured data, just fed
// deliberately-constructed input instead of whatever the sandbox's fake
// Wi-Fi state would otherwise report (there is no real radio here to read).
function syntheticDiagnostics(scenario, flapIndex) {
  const base = { bssid: 'aa:bb:cc:00:11:22', rssi: '-55', noise: '-92', leaseTime: '43200' };

  switch (scenario) {
    case 'bssid-roam':
      // Different BSSID on each flap = actually roamed to another AP.
      return { ...base, bssid: flapIndex % 2 === 0 ? 'aa:bb:cc:00:11:22' : 'aa:bb:cc:33:44:55' };
    case 'weak-signal':
      return { ...base, rssi: '-82' };
    case 'dhcp-lease-churn':
      return { ...base, leaseTime: '300' };
    case 'rf-interference':
      return { ...base, rssi: '-60', noise: '-50' }; // SNR 10dB < 15dB threshold
    default:
      // No forced scenario — healthy-looking data on purpose (same BSSID,
      // strong RSSI, good SNR, long lease), so none of the four rules match
      // and the "insufficient-signal" honest fallback is what a plain run
      // actually demonstrates — same as a real machine flapping for a
      // reason none of these rules cover.
      return { ...base };
  }
}

// Shared ticket-filing plumbing for both friction types: create -> (resolve
// immediately + notify) on the auto-fix path, or (leave open + poll) on the
// needs-approval path. `diagnosis` only needs .description/.fix/.confidence
// for the notifier/resolution-note text — app-crash's is a much simpler
// fixed object than Wi-Fi's real rule-scored one (see
// handleAppCrashPatternDetected).
async function fileFrictionTicket({ subject, descriptionHtml, gate, tags, diagnosis }) {
  console.log(`[tally] policy gate: ${gate.autoFixable ? 'AUTO-FIX' : 'NEEDS APPROVAL'} — ${gate.reason}`);

  const payload = {
    subject,
    description: descriptionHtml,
    status: TICKET_STATUS.OPEN,
    group_id: gate.autoFixable ? null : Number(process.env.FRESHSERVICE_GROUP_ID_FOR_APPROVAL) || undefined,
    tags,
  };

  try {
    const { ticket } = await createTicket(payload);
    console.log(`[tally] ticket #${ticket.display_id} created — status ${ticket.status}`);

    if (gate.autoFixable) {
      // Auto-resolve path: resolve it immediately via a follow-up PUT, then
      // notify right away — same end state the listener would eventually
      // see, just without waiting on a poll for something already decided.
      const resolved = await resolveTicket(ticket.id, {
        status: TICKET_STATUS.RESOLVED,
        resolutionNotes: `Applied automatically by Tally: ${diagnosis.fix} (diagnosed cause: ${diagnosis.description}, confidence ${diagnosis.confidence}).`,
      });
      console.log(`[tally] ticket #${resolved.ticket.display_id} resolved — status ${resolved.ticket.status}`);
      const { notifyResolved } = require('./notifier');
      notifyResolved({ ticketDisplayId: resolved.ticket.display_id, cause: diagnosis.description, fix: diagnosis.fix });
    } else {
      // Needs-approval path: left open, assigned to the approval group.
      // Poll for whenever an agent resolves it, then notify.
      watchForResolution({ ticket, diagnosis });
    }
  } catch (err) {
    console.error('[tally] failed to create ticket:', err.message);
  }
}

async function handleWifiPatternDetected(flaps) {
  console.log(`\n[tally] Wi-Fi pattern detected — ${flaps.length} flaps in the window`);

  // Diagnosis still runs for real, against real captured diagnostics — it's
  // what fills in the "Diagnosed cause" text on the ticket. Only the gate
  // decision below is fixed, not this.
  const diagnosis = diagnose(flaps);
  console.log(
    `[tally] diagnosed cause: "${diagnosis.description}" ` +
      `(confidence ${diagnosis.confidence}, explains ${diagnosis.explained}/${diagnosis.total} events)`
  );

  const lastDiagnostics = flaps[flaps.length - 1]?.diagnostics || {};
  const gate = wifiGateFor(diagnosis);

  await fileFrictionTicket({
    subject: `Repeated Wi-Fi disconnects — ${diagnosis.description}`,
    descriptionHtml: buildDescriptionHtml({ diagnosis, lastDiagnostics, gate }),
    gate,
    tags: ['tally', 'wifi'],
    diagnosis,
  });
}

function runSimulateMode(args) {
  console.log(
    `[tally] simulate mode — injecting two synthetic Wi-Fi flaps` +
      (args.forceScenario ? ` (scenario: ${args.forceScenario})` : ' (no scenario — ambiguous diagnostics)')
  );
  const engine = createPatternEngine(config.pattern);
  const iface = process.platform === 'darwin' ? detectWifiInterface() : 'en0 (simulated)';

  function injectFlap(index) {
    const now = Date.now();
    const flap = {
      downAt: now - 2000,
      upAt: now,
      ssid: 'corp-wifi (simulated)',
      iface,
      diagnostics: syntheticDiagnostics(args.forceScenario, index),
    };
    const window = engine.recordFlap(flap);
    if (window) handleWifiPatternDetected(window);
  }

  injectFlap(0);
  setTimeout(() => injectFlap(1), 3000);
}

async function handleAppCrashPatternDetected(events) {
  console.log(`\n[tally] App-crash pattern detected — ${events.length} crash/reopen(s) in the window`);

  // No rule-based diagnosis here, same reasoning as the old VPN path — no
  // equivalent real diagnostic data source for "why did the app crash" in
  // this build, so this doesn't pretend to have investigated a root cause.
  // It just reports what was observed and always routes to a human, per
  // the fixed APP_CRASH_GATE policy.
  const diagnosis = {
    description: `${config.appCrash.matchPattern} disappeared and reopened ${events.length} time(s) within the detection window — repeated crash/force-quit, not diagnosed further`,
    fix: 'Check Console.app crash logs for this app around the reported times; consider reinstalling/updating if it recurs',
    confidence: 'N/A',
  };
  const gate = APP_CRASH_GATE;

  const descriptionHtml = [
    field('SAY', `Detected ${events.length} crash/reopen(s) of ${config.appCrash.matchPattern} with no ticket filed.`),
    field('Observed', diagnosis.description),
    field('Proposed next step', diagnosis.fix),
  ].join('\n');

  await fileFrictionTicket({
    subject: `Repeated application crashes — ${config.appCrash.matchPattern} (${events.length} crash/reopen cycles)`,
    descriptionHtml,
    gate,
    tags: ['tally', 'app-crash'],
    diagnosis,
  });
}

function runLiveMode(args) {
  console.log(`[tally] live mode — watching real Wi-Fi interface and "${config.appCrash.matchPattern}" process`);
  const wifiEngine = createPatternEngine(config.pattern);

  startWifiWatcher({
    pollIntervalMs: config.capture.pollIntervalMs,
    onStateChange: ({ connected, ssid }) => {
      console.log(`[capture] Wi-Fi ${connected ? 'connected' : 'disconnected'}${ssid ? ` (${ssid})` : ''}`);
    },
    onFlap: (flap) => {
      console.log(`[capture] flap recorded at ${new Date(flap.upAt).toISOString()}`, flap.diagnostics);
      const window = wifiEngine.recordFlap(flap);
      if (window) handleWifiPatternDetected(window);
    },
  });

  const { startAppCrashWatcher } = require('./appCrashCapture');
  const crashEngine = createPatternEngine(config.pattern);

  startAppCrashWatcher({
    pollIntervalMs: config.capture.pollIntervalMs,
    matchPattern: config.appCrash.matchPattern,
    onStateChange: ({ running }) => {
      console.log(`[appCrashCapture] ${config.appCrash.matchPattern} ${running ? 'running' : 'not running (crashed/quit)'}`);
    },
    onFlap: (flap) => {
      console.log(`[appCrashCapture] crash/reopen cycle recorded at ${new Date(flap.upAt).toISOString()}`);
      const window = crashEngine.recordFlap(flap);
      if (window) handleAppCrashPatternDetected(window);
    },
  });
}

function runSimulateCrashMode() {
  console.log(`[tally] simulate mode — injecting two synthetic "${config.appCrash.matchPattern}" crash/reopen cycles`);
  const engine = createPatternEngine(config.pattern);

  function injectFlap() {
    const now = Date.now();
    const window = engine.recordFlap({ downAt: now - 2000, upAt: now });
    if (window) handleAppCrashPatternDetected(window);
  }

  injectFlap();
  setTimeout(injectFlap, 3000);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[tally] starting — mode=${config.mode}`);

  if (args.simulateFlap) {
    runSimulateMode(args);
  } else if (args.simulateCrashFlap) {
    runSimulateCrashMode();
  } else {
    runLiveMode(args);
  }
}

main();
