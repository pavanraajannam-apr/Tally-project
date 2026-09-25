// Wi-Fi capture — watches the laptop's Wi-Fi interface for down -> up transitions
// ("flaps") and emits one event per completed flap, timestamped at the moment
// the connection comes back.
//
// macOS only (uses `networksetup`). This is the one module that has to live
// outside the Rails app by necessity — itildesk has no visibility into a
// laptop's local network stack.

const { execSync } = require('child_process');
const { captureDiagnosticsSnapshot } = require('./osDiagnostics');

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    // networksetup returns non-zero exit codes for some "not connected" states —
    // treat command failure as "no output" rather than crashing the watcher.
    return err.stdout ? err.stdout.toString() : '';
  }
}

// Finds the hardware port name for Wi-Fi (e.g. "en0") without hardcoding it,
// since it varies across Mac models.
function detectWifiInterface() {
  const listing = sh('networksetup -listallhardwareports');
  const blocks = listing.split(/\n\s*\n/);

  for (const block of blocks) {
    if (/Wi-Fi|AirPort/i.test(block)) {
      const match = block.match(/Device:\s*(\S+)/);
      if (match) return match[1];
    }
  }
  // reasonable fallback for most modern Macs
  return 'en0';
}

// Returns { connected: bool, ssid: string|null } for the given interface,
// using `-getairportnetwork` (association with a specific network) as a
// best-effort signal for SSID display only — see readAirportPower() below
// for the primary connected/disconnected signal.
function readWifiState(iface) {
  const output = sh(`networksetup -getairportnetwork ${iface}`);
  const notAssociated = /not associated/i.test(output);
  if (notAssociated) return { connected: false, ssid: null };

  const match = output.match(/Current Wi-Fi Network:\s*(.+)/);
  if (match) return { connected: true, ssid: match[1].trim() };

  // Unexpected output shape — treat as disconnected rather than guessing.
  return { connected: false, ssid: null };
}

// Whether the Wi-Fi radio itself is powered on — this is what actually
// flips when you toggle Wi-Fi off/on from the menu bar or Control Center
// (the exact action the demo does), and unlike `-getairportnetwork` it
// doesn't require Location Services permission to report correctly on
// recent macOS. This is the primary signal the watcher uses below;
// `readWifiState()` is only consulted for a friendlier SSID in logs.
function readAirportPower(iface) {
  const output = sh(`networksetup -getairportpower ${iface}`);
  const match = output.match(/Wi-Fi Power \([^)]*\):\s*(On|Off)/i);
  if (!match) return null; // couldn't parse — caller should treat as "unknown"
  return /on/i.test(match[1]);
}

/**
 * Starts polling the Wi-Fi interface. Calls onFlap({ downAt, upAt, ssid })
 * once per completed down -> up cycle.
 *
 * Returns a stop() function.
 */
function startWifiWatcher({ pollIntervalMs, onFlap, onStateChange } = {}) {
  if (process.platform !== 'darwin') {
    console.warn(
      '[capture] Not running on macOS — real Wi-Fi capture is unavailable here. ' +
        'Use --simulate-flap instead.'
    );
    return () => {};
  }

  const iface = detectWifiInterface();
  console.log(`[capture] watching Wi-Fi interface ${iface}`);

  let lastConnected = null;
  let downAt = null;
  let lastSsid = null;
  let usingPowerFallbackWarned = false;

  const timer = setInterval(() => {
    const powerOn = readAirportPower(iface);
    let connected;
    let ssid = null;

    if (powerOn === null) {
      // Couldn't parse `-getairportpower` output at all (unexpected on
      // macOS, but don't crash the watcher) — fall back to the
      // association-based check, with a one-time warning since that path
      // can silently misreport if Location Services access is missing.
      if (!usingPowerFallbackWarned) {
        console.warn(
          '[capture] could not read Wi-Fi radio power state — falling back to ' +
            'association-based detection, which may miss power-only toggles ' +
            'if Terminal lacks Location Services permission.'
        );
        usingPowerFallbackWarned = true;
      }
      const state = readWifiState(iface);
      connected = state.connected;
      ssid = state.ssid;
    } else {
      connected = powerOn;
      if (powerOn) ssid = readWifiState(iface).ssid;
    }

    if (lastConnected === null) {
      // first read — just establish baseline, don't fire anything
      lastConnected = connected;
      lastSsid = ssid;
      return;
    }

    if (connected !== lastConnected) {
      onStateChange && onStateChange({ connected, ssid, at: Date.now() });

      if (!connected) {
        downAt = Date.now();
      } else if (downAt !== null) {
        const upAt = Date.now();
        // Snapshot the real OS-level diagnostics (BSSID/RSSI/noise/DHCP lease)
        // at the moment the flap completes — this is what diagnosis.js scores
        // against instead of any static/seeded data.
        const diagnostics = captureDiagnosticsSnapshot(iface);
        onFlap({ downAt, upAt, ssid: ssid || lastSsid, iface, diagnostics });
        downAt = null;
      }
    }

    lastConnected = connected;
    if (ssid) lastSsid = ssid;
  }, pollIntervalMs);

  return () => clearInterval(timer);
}

module.exports = { startWifiWatcher, detectWifiInterface, readWifiState, readAirportPower };
