# Readme

## Title

**Tally**

### Description

The tickets nobody filed — an agent that detects, diagnoses, and files the IT friction employees never report.

## What it is

Tally is a local agent that watches two independent, real, on-device signals — Wi-Fi radio flaps and target-app crashes — for repeated friction. When a pattern repeats within a rolling window, it scores real OS diagnostics against known-cause rules, decides whether it's safe to auto-resolve or needs a human, and files (and where safe, resolves) a Freshservice ticket through the standard public v2 Ticket API. One process, no custom backend.

## What it does (business objective)

Closes the gap between what IT's queue shows and what's actually happening on employee machines. Per the DEX research cited in the pitch deck, 79% of employees fix IT problems themselves rather than filing a ticket — so the queue is a filtered, unreliable view of reality, and CSAT numbers miss most of the friction that's actually costing time. Tally turns that silent friction into logged, evidenced tickets: auto-resolving the low-risk noise (so it doesn't clutter the queue) and escalating anything it can't safely explain to a human, without requiring a new platform, a migration, or a custom Freshservice backend.

## What it doesn't do (out of scope)

- Doesn't invent or simulate friction for the live demo — every ticket comes from a real local signal (`npm run simulate*` exists only for rehearsal, and is clearly separated from live mode in the code).
- Doesn't auto-fix anything it can't explain — any diagnosed Wi-Fi cause, or any app crash, always routes to human approval; auto-resolve only fires when nothing specific was found.
- Doesn't correlate one root cause across multiple employees yet — the "population panel" from the original vision is roadmap, not built this hackathon.
- Doesn't cover VPN, password-reset, or certificate-profile signals yet (roadmap). VPN was specifically evaluated and dropped for this build — on this hardware, VPN state isn't independent of Wi-Fi (GlobalProtect's tunnel rides the Wi-Fi link), so it was replaced with app-crash detection to keep the two demo signals uncorrelated.
- Doesn't need any custom Freshservice route or backend change — it only talks to the standard public `api/v2/tickets` endpoints any external integration uses.

## Product Integrations

| Product | Used for |
|---|---|
| Freshservice (Freshworks) | Ticket creation, HTML-described diagnostics, resolution, and the approval workflow — via the standard public v2 Ticket API. Real tickets in live mode; a same-shaped mock server for rehearsal. |

Sarvam, Anthropic, Vobiz, Databricks — not used in this build.

## System Interaction Diagram [Optional]

```
 Wi-Fi radio state  ──┐
 (networksetup/       │
  airport, polled)    │
                       ├──▶  Pattern Engine  ──▶  Diagnosis Engine   ──▶  Policy Gate
 Target app process ──┘     (repetition, N in     (scores real OS         │
 (pgrep, polled)            a rolling window)      diagnostics vs.        │
                                                    4 known-cause rules    │
                                                    — Wi-Fi only;          │
                                                    crashes have none)     │
                                                                           ▼
                                                          auto-resolve ◀───┴───▶ needs approval
                                                              │                       │
                                                              ▼                       ▼
                                                     Freshservice Ticket API (create → resolve/poll)
                                                              │
                                                              ▼
                                                  Resolution Listener ──▶ native macOS notification
```

Everything above the Freshservice API line runs locally, on-device, in one Node process (`src/index.js`).

---

## What's still a hackathon shortcut

- Diagnosis only covers four rules, chosen because they're the signals actually available from `system_profiler`/`ipconfig getpacket` on a laptop (RSSI, noise, DHCP lease — BSSID isn't obtainable via CLI without a Location Services entitlement on recent macOS). A production version would add more rules (e.g. channel/interference history, AP-side logs) rather than more seeded data — the scoring approach itself doesn't need to change.
- Ticket creation/resolution goes through the public v2 API directly, not an async event bus (Kafka's `karafka.rb`) a higher-volume production version might belong on.
- The "population" panel (others affected by the same cause) isn't wired up in this tool yet — per the plan doc, it's either run against a second real device if one's available at demo time, or explicitly labeled illustrative if not.

Both are called out the same way in `Tally_Build_Approach.html` — nothing here claims to be more finished than it is.

## How the pieces fit

| File | Role |
|---|---|
| `src/capture.js` | Watches the real Wi-Fi interface for down→up flaps (macOS); snapshots diagnostics at each flap |
| `src/appCrashCapture.js` | Watches a target app process (default: VS Code) for crash/force-quit → reopen cycles — the second demo scenario, replacing VPN detection |
| `src/osDiagnostics.js` | Pulls BSSID/RSSI/noise/DHCP lease info at each flap |
| `src/diagnosis.js` | Rule-based scoring engine — 4 rules (`bssid-roam`, `weak-signal`, `dhcp-lease-churn`, `rf-interference`), each scored against the real diagnostics captured per flap; falls back to an honest `insufficient-signal`/LOW-confidence result if nothing scores above 0 |
| `src/changeLog.js` | Superseded/unused — see file header; kept only for reference |
| `src/patternEngine.js` | Rolling-window threshold evaluator (2 in 5 min) |
| `src/policyGate.js` | Auto-fix vs. needs-approval decision |
| `src/freshserviceClient.js` | Create/resolve/poll a ticket via the standard public v2 Ticket API — mock or real mode, same code path either way |
| `src/resolutionListener.js` | Polls the created ticket, triggers the notifier on `Resolved` |
| `src/notifier.js` | Fires the native macOS notification |
| `src/index.js` | Wires it all together; CLI entry point |
| `mock-server/server.js` | Mirrors `/api/v2/tickets` (create/update/get) with zero credentials needed |

## Installation

### Requirements

- macOS (capture and notification are macOS-specific — `networksetup`, `airport`, `ipconfig`, `osascript`)
- Node.js 18+ (uses global `fetch`)

### Setup

```
cd tally
npm install
cp .env.example .env
```

Leave `MODE=mock` in `.env` to run against the bundled mock server with no credentials. To point at a real Freshservice stack, set:

```
MODE=freshservice
FRESHSERVICE_DOMAIN=yourdomain.freshservice.com
FRESHSERVICE_API_KEY=your_api_key
FRESHSERVICE_REQUESTER_EMAIL=someone@yourdomain.com
FRESHSERVICE_GROUP_ID_FOR_APPROVAL=<a real group id>
```

That's it — no server-side change needed. This tool talks to the standard public v2 Ticket API (`POST /api/v2/tickets`, `PUT /api/v2/tickets/:id`, `GET /api/v2/tickets/:id`), the same one any external integration uses, so any Freshservice account with an API key works as-is.

### Running it

**Rehearse without real Wi-Fi hardware** (recommended before every demo):

```
npm run simulate            # bssid-roam -> low-risk, auto-resolve path
npm run simulate:approval   # dhcp-lease-churn -> high-risk, needs-approval path
npm run simulate:crash      # two synthetic app crash/reopen cycles -> needs-approval path
```

Each injects two synthetic flap events 3 seconds apart (clears the 2-in-5-minute threshold) carrying synthetic OS diagnostics (BSSID/RSSI/noise/DHCP lease) built to match one specific rule in `src/diagnosis.js`. The scoring algorithm that runs is the exact same code that scores real captured diagnostics in live mode — `--force-scenario` only controls what fake radio data gets fed in, not the outcome. Run `node src/index.js --simulate-flap` with no scenario flag and you'll see the honest fallback: deliberately ambiguous diagnostics that don't clearly match any rule produce `insufficient-signal` at LOW confidence, same as a real machine would if nothing stood out.

Available scenarios: `bssid-roam`, `weak-signal`, `dhcp-lease-churn`, `rf-interference` (these are the four rule IDs in `src/diagnosis.js`).

**Real live demo — two independent scenarios, one process:**

```
npm start
```

- **Wi-Fi (auto-resolve path):** physically turn Wi-Fi off and back on twice within 5 minutes. Watch for `[capture]` log lines; if no known pattern matches the real diagnostics, the ticket auto-resolves as a transient blip.
- **App crash (needs-approval path):** force-quit the app named in `APP_CRASH_MATCH_PATTERN` (defaults to `Visual Studio Code`) and reopen it, twice within 5 minutes. Watch for `[appCrashCapture]` log lines; this always needs approval — there's no diagnosis engine for it, just the observed crash/reopen count.

Either way, watch the terminal for `[tally]` and `[listener]` log lines as the tool moves through capture → pattern → diagnosis → gate → ticket → resolution → notification.

**Mock server** (only needed for `MODE=mock`, run in a separate terminal):

```
npm run mock-server
```

The mock server mirrors the real `/api/v2/tickets` routes exactly, plus a couple of mock-only debug endpoints:
- `GET  http://localhost:4001/mock/tickets` — list all mock tickets
- `POST http://localhost:4001/mock/tickets/:id/resolve` — manually resolve a needs-approval ticket at the moment you choose, instead of waiting on the auto-resolve timer (`MOCK_AUTO_RESOLVE_MS`, default 20s)
