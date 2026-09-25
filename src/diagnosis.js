// Diagnosis engine — rewritten to score against the REAL OS diagnostics
// captured at each flap (osDiagnostics.js: BSSID, RSSI, noise, DHCP lease),
// not static "minutes ago" change-log offsets. The old changeLog.js
// approach always tied 4-for-4 against a real flap window (every seeded
// timestamp was always "in the past" relative to now) and silently fell
// back to "whichever entry is newest" — which is indistinguishable from
// hardcoding. This version can't do that: every rule below only wins if
// the actual radio/DHCP data captured on THIS machine, at THIS flap,
// supports it. No data matching a rule's criteria -> it scores 0, same as
// every other rule -> the tool admits low confidence instead of guessing.
//
// Input shape: an array of flap objects, each:
//   { downAt, upAt, ssid, diagnostics: { bssid, rssi, noise, leaseTime, ... } }
// (see capture.js — diagnostics are captured at the moment each flap
// completes, not once for the whole window.)

function toNum(v) {
  // Number(null) === 0 and Number.isFinite(0) === true, so a naive
  // Number(v) check silently turns a missing reading into a literal 0 —
  // which then falsely satisfies "RSSI <= -75", "SNR < 15dB", or
  // "leaseTime <= 3600s" for a flap that actually just has no data yet
  // (e.g. system_profiler queried a beat before the radio finished
  // reassociating). Confirmed on a real run: a flap with rssi/noise both
  // null scored as a fake 0dBm/0dBm interference match. Must explicitly
  // reject null/undefined/'' before ever calling Number() on it.
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Fraction of flaps (that actually have the relevant field) matching a
// predicate. Flaps missing the field entirely are excluded from the
// denominator rather than counted as non-matches — no data shouldn't look
// like contradicting evidence.
function fractionMatching(flaps, hasData, matches) {
  const withData = flaps.filter((f) => hasData(f.diagnostics || {}));
  if (withData.length === 0) return { score: 0, evaluable: 0, matched: 0 };
  const matched = withData.filter((f) => matches(f.diagnostics)).length;
  return { score: matched / withData.length, evaluable: withData.length, matched };
}

const RULES = [
  {
    id: 'bssid-roam',
    label: 'Device roaming between access points',
    autoFixable: true,
    riskLevel: 'low',
    fix: 'Nudge the device to reassociate with the nearest access point (client-side roaming aggressiveness)',
    evaluate(flaps) {
      let comparable = 0;
      let changed = 0;
      const bssids = [];
      for (let i = 1; i < flaps.length; i++) {
        const prev = flaps[i - 1].diagnostics?.bssid;
        const curr = flaps[i].diagnostics?.bssid;
        if (prev && curr) {
          comparable++;
          if (prev !== curr) {
            changed++;
            bssids.push(`${prev} -> ${curr}`);
          }
        }
      }
      if (comparable === 0) return { score: 0, evidence: 'no comparable BSSID readings across flaps' };
      return {
        score: changed / comparable,
        evidence: bssids.length ? `BSSID changed on reconnect: ${bssids.join(', ')}` : 'BSSID stayed constant across flaps',
      };
    },
  },
  {
    id: 'weak-signal',
    label: 'Persistently weak signal strength',
    autoFixable: false,
    riskLevel: 'medium',
    fix: 'Review access point coverage/placement for this location',
    evaluate(flaps) {
      const { score, evaluable, matched } = fractionMatching(
        flaps,
        (d) => toNum(d.rssi) !== null,
        (d) => toNum(d.rssi) <= -75
      );
      const values = flaps.map((f) => f.diagnostics?.rssi).filter((v) => v !== undefined && v !== null);
      return {
        score,
        evidence: evaluable ? `RSSI at each flap: ${values.join(', ')} dBm (${matched}/${evaluable} <= -75dBm)` : 'no RSSI readings available',
      };
    },
  },
  {
    id: 'dhcp-lease-churn',
    label: 'DHCP lease too short, forcing frequent renegotiation',
    autoFixable: false,
    riskLevel: 'high',
    fix: 'Extend the DHCP lease duration on this VLAN',
    evaluate(flaps) {
      const SHORT_LEASE_SECONDS = 3600; // 1 hour
      const { score, evaluable, matched } = fractionMatching(
        flaps,
        (d) => toNum(d.leaseTime) !== null,
        (d) => toNum(d.leaseTime) <= SHORT_LEASE_SECONDS
      );
      const values = flaps.map((f) => f.diagnostics?.leaseTime).filter((v) => v !== undefined && v !== null);
      return {
        score,
        evidence: evaluable ? `DHCP lease_time at each flap: ${values.join(', ')}s (${matched}/${evaluable} <= ${SHORT_LEASE_SECONDS}s)` : 'no DHCP lease data available',
      };
    },
  },
  {
    id: 'rf-interference',
    label: 'Poor signal-to-noise ratio — likely RF interference',
    autoFixable: false,
    riskLevel: 'medium',
    fix: 'Investigate RF interference sources near this device (channel overlap, non-Wi-Fi 2.4/5GHz emitters)',
    evaluate(flaps) {
      const { score, evaluable, matched } = fractionMatching(
        flaps,
        (d) => toNum(d.rssi) !== null && toNum(d.noise) !== null,
        (d) => toNum(d.rssi) - toNum(d.noise) < 15
      );
      const pairs = flaps
        .map((f) => {
          const r = f.diagnostics?.rssi;
          const n = f.diagnostics?.noise;
          return r !== undefined && r !== null && n !== undefined && n !== null ? `${r}/${n}` : null;
        })
        .filter(Boolean);
      return {
        score,
        evidence: evaluable ? `RSSI/noise per flap: ${pairs.join(', ')} (${matched}/${evaluable} SNR < 15dB)` : 'no RSSI/noise pair available',
      };
    },
  },
];

function confidenceLabel(score) {
  if (score >= 0.8) return 'HIGH';
  if (score >= 0.5) return 'MEDIUM';
  return 'LOW';
}

/**
 * @param {Array} flaps - flap objects with .diagnostics attached at capture
 *   time (see capture.js). No forced/hardcoded cause selection — every
 *   rule is scored purely against what's actually in `diagnostics`.
 */
function diagnose(flaps) {
  const scored = RULES.map((rule) => {
    const { score, evidence } = rule.evaluate(flaps);
    return { ...rule, score, evidence };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const total = flaps.length;
  const confidence = confidenceLabel(best.score);

  if (best.score === 0) {
    return {
      id: 'insufficient-signal',
      description: `No single cause stood out from the captured diagnostics across ${total} flap(s) — none of the known patterns (roaming, weak signal, DHCP churn, interference) matched.`,
      confidence: 'LOW',
      autoFixable: false,
      riskLevel: 'unknown',
      fix: 'Manual RF diagnostic review recommended',
      explained: 0,
      total,
      allCandidates: scored,
    };
  }

  return {
    id: best.id,
    description: `${best.label} — ${best.evidence}`,
    confidence,
    autoFixable: best.autoFixable,
    riskLevel: best.riskLevel,
    fix: best.fix,
    explained: Math.round(best.score * total),
    total,
    allCandidates: scored,
  };
}

module.exports = { diagnose, RULES, confidenceLabel };
