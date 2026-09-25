// RETIRED — no longer used by index.js.
//
// This watched VPN connect/disconnect state via `route -n get default`
// ownership (utun* interface = connected). It worked correctly, but turned
// out not to be an independent signal on this machine: GlobalProtect's
// tunnel rides on top of the Wi-Fi link, so toggling Wi-Fi necessarily also
// flaps the VPN's default-route ownership. Confirmed live — a single Wi-Fi
// on/off toggle test filed BOTH a Wi-Fi ticket and a VPN ticket, when the
// two demo scenarios were meant to be independent.
//
// Replaced by appCrashCapture.js (watches a target app process instead —
// no network entanglement, cleanly isolates from the Wi-Fi scenario). This
// file is kept only for reference; it is not required/imported anywhere.
// Safe to delete if your filesystem allows it.

module.exports = {};
