// SUPERSEDED — no longer used.
//
// This originally seeded static "recent network change" candidates that
// diagnosis.js picked from. That approach always tied 4-for-4 against any
// real flap window (every seeded timestamp was always "in the past"),
// which meant the outcome was effectively hardcoded to array/recency order
// regardless of what actually happened on the Wi-Fi radio.
//
// diagnosis.js now scores rule-based candidates directly against the real
// OS diagnostics captured at each flap (see osDiagnostics.js / capture.js) —
// BSSID changes, RSSI, noise, DHCP lease time — so nothing here is imported
// anymore. Left in place (unused) rather than deleted so the "before" state
// is visible if anyone wants to see what changed and why.

module.exports = {};
