// Pulls the OS-level Wi-Fi diagnostics available only on the device itself —
// this is why diagnosis has to run inside the Tally tool rather than being
// shipped off to a server: none of this exists anywhere else.

const { execSync } = require('child_process');

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    return err.stdout ? err.stdout.toString() : '';
  }
}

// RSSI + noise + channel, via `system_profiler SPAirPortDataType`.
//
// The original implementation shelled out to Apple's `airport -I` utility
// (a private Apple80211.framework binary). That binary no longer exists on
// recent macOS (confirmed: `zsh: no such file or directory` on the actual
// demo machine) — Apple has been removing it. `system_profiler` is the
// current replacement Apple ships instead.
//
// Its report also lists every other visible AP under "Other Local Wi-Fi
// Networks:", each with its own "Signal / Noise:" line — matching that
// pattern globally would silently pick up a neighbor's numbers instead of
// this device's own connection, so this only reads inside the "Current
// Network Information:" block, up to wherever the neighbor-list section
// (if any) starts.
//
// BSSID is NOT available from this command on recent macOS without a
// Location Services entitlement the CLI doesn't have — left null rather
// than guessed. That means the bssid-roam rule in diagnosis.js simply has
// no data to score on this hardware/macOS combination (same honest
// "insufficient signal" treatment as any other missing field) — every
// other rule still gets real RSSI/noise.
function readRadioInfo() {
  if (process.platform !== 'darwin') return {};

  const output = sh('system_profiler SPAirPortDataType');
  if (!output) return {};

  const currentBlockMatch = output.match(
    /Current Network Information:([\s\S]*?)(?:\n\s*Other Local Wi-Fi Networks:|$)/
  );
  const block = currentBlockMatch ? currentBlockMatch[1] : '';
  if (!block) return {};

  const signalNoise = block.match(/Signal\s*\/\s*Noise:\s*(-?\d+)\s*dBm\s*\/\s*(-?\d+)\s*dBm/);
  const channelMatch = block.match(/Channel:\s*(\d+)/);

  return {
    bssid: null,
    rssi: signalNoise ? signalNoise[1] : null,
    noise: signalNoise ? signalNoise[2] : null,
    channel: channelMatch ? channelMatch[1] : null,
  };
}

// DHCP lease details for the interface — a lease renewal right before a flap
// is one of the strongest real-world signals for "why did this reconnect."
//
// Real `ipconfig getpacket` output on modern macOS is "key (type): value",
// e.g. `lease_time (uint32): 0x5f50` / `server_identifier (ip): 10.11.7.1` —
// NOT the "key = value" shape this originally assumed, which meant these
// two fields silently never matched and were always null. Values come back
// as hex ("0x5f50"); Number("0x5f50") parses that correctly in JS, so
// leaseTime is left as the raw hex string and toNum() in diagnosis.js
// handles the conversion.
function readDhcpInfo(iface) {
  if (process.platform !== 'darwin') return {};

  const output = sh(`ipconfig getpacket ${iface}`);
  if (!output) return {};

  const get = (re) => {
    const m = output.match(re);
    return m ? m[1].trim() : null;
  };

  return {
    leaseTime: get(/lease_time\s*\([^)]*\):\s*(\S+)/i),
    serverId: get(/server_identifier\s*\([^)]*\):\s*(\S+)/i),
  };
}

/**
 * Snapshot of everything Tally can see about the device's network state
 * at the moment a flap happened. Best-effort — any field can be null
 * if the OS doesn't return it (or we're not on macOS).
 */
function captureDiagnosticsSnapshot(iface) {
  return {
    at: Date.now(),
    ...readRadioInfo(),
    ...readDhcpInfo(iface),
  };
}

module.exports = { captureDiagnosticsSnapshot, readRadioInfo, readDhcpInfo };
