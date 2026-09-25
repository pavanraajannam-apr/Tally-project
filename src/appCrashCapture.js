// App-crash capture — watches a target application process for unexpected
// disappearances ("crashes" / force-quits), the same down -> up flap shape
// as the Wi-Fi watcher.
//
// This replaces the earlier VPN watcher for the second demo scenario. VPN
// detection (via `route -n get default` ownership) turned out not to be an
// independent signal on this machine: GlobalProtect's tunnel rides on top
// of the Wi-Fi link, so toggling Wi-Fi necessarily also flaps the VPN's
// default-route ownership. Confirmed live — a single Wi-Fi on/off toggle
// test filed BOTH a Wi-Fi ticket and a VPN ticket, when the two scenarios
// were meant to be independent. A process crash has no such entanglement
// with the network stack, so it cleanly isolates from the Wi-Fi scenario.
//
// Detection: poll for the target app's process by a substring match against
// the full command line (`pgrep -f`) rather than an exact process-name
// match, since Electron-based apps (VS Code, Cursor, Slack, etc.) often run
// under a different literal binary name than the app's display name.
//
//   "down" = matching process count drops to 0 (force-quit / crash)
//   "up"   = matching process count goes back above 0 (you reopened it)
//
// One down -> up cycle = one flap, same shape/semantics fed into the same
// pattern engine used for Wi-Fi.

const { execSync } = require('child_process');

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    // pgrep exits non-zero when it finds nothing — that's a normal "not
    // running" result, not a real error.
    return err.stdout ? err.stdout.toString() : '';
  }
}

// Returns { running: bool } for the configured process match pattern.
function readProcessState(matchPattern) {
  const output = sh(`pgrep -f "${matchPattern}"`);
  return { running: output.trim().length > 0 };
}

/**
 * Starts polling for the target app. Calls onFlap({ downAt, upAt }) once per
 * crash event.
 *
 * The FIRST crash still waits for a real reopen before counting (down ->
 * up = one confirmed flap) — that establishes there's a genuine crash/
 * recovery cycle, not just the app being quit deliberately and left closed.
 * Every crash AFTER that first confirmed one counts immediately at the
 * moment it goes down, without waiting for you to reopen it — once a real
 * crash/recovery cycle is already on record, a second crash is itself
 * enough evidence of a repeat pattern, so there's no reason to hold the
 * ticket open waiting on a reopen that isn't needed to prove anything
 * further. (`upAt` is set equal to `downAt` for these fast-fired events —
 * the pattern engine only uses it as a timestamp, not as proof the app came
 * back.) If you do reopen after a fast-fired crash, that reopen is not
 * double-counted as a second event.
 *
 * Returns a stop() function.
 */
function startAppCrashWatcher({ pollIntervalMs, matchPattern, onFlap, onStateChange } = {}) {
  if (process.platform !== 'darwin') {
    console.warn('[appCrashCapture] Not running on macOS — app crash capture is unavailable here.');
    return () => {};
  }
  if (!matchPattern) {
    console.warn('[appCrashCapture] No matchPattern configured — app crash capture is disabled.');
    return () => {};
  }

  console.log(`[appCrashCapture] watching for process matching "${matchPattern}"`);

  let lastRunning = null;
  let downAt = null;
  let crashesRecorded = 0;
  let awaitingUpForFastFired = false;

  const timer = setInterval(() => {
    const { running } = readProcessState(matchPattern);

    if (lastRunning === null) {
      // first read — just establish baseline, don't fire anything
      lastRunning = running;
      return;
    }

    if (running !== lastRunning) {
      onStateChange && onStateChange({ running, at: Date.now() });

      if (!running) {
        const at = Date.now();
        if (crashesRecorded >= 1) {
          // Already have one confirmed crash/reopen cycle on record — this
          // crash counts immediately, no reopen required.
          onFlap({ downAt: at, upAt: at });
          crashesRecorded++;
          awaitingUpForFastFired = true;
          downAt = null;
        } else {
          // First crash — wait for the real reopen below.
          downAt = at;
        }
      } else if (awaitingUpForFastFired) {
        // This reopen corresponds to a crash already counted at down-time —
        // don't count it again.
        awaitingUpForFastFired = false;
      } else if (downAt !== null) {
        const upAt = Date.now();
        onFlap({ downAt, upAt });
        crashesRecorded++;
        downAt = null;
      }
    }

    lastRunning = running;
  }, pollIntervalMs);

  return () => clearInterval(timer);
}

module.exports = { startAppCrashWatcher, readProcessState };
