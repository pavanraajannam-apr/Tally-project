// Pattern engine — "repetition, not severity". Holds a rolling window of
// flap events (now carrying their own diagnostics snapshot, not just a
// timestamp — diagnosis.js needs the real per-flap data) and decides when
// there are enough of them, close enough together, to be worth diagnosing.

function createPatternEngine({ thresholdCount, thresholdWindowMs }) {
  let flaps = [];
  let lastFiredAt = 0;
  const COOLDOWN_MS = thresholdWindowMs; // don't re-fire on the same cluster of flaps

  function pruneOldFlaps(now) {
    flaps = flaps.filter((f) => now - f.upAt <= thresholdWindowMs);
  }

  /**
   * Records a flap ({ downAt, upAt, ssid, iface, diagnostics }) and returns
   * the current window's flaps if the pattern just crossed threshold (and
   * isn't in cooldown), otherwise null.
   */
  function recordFlap(flap) {
    const now = flap.upAt || Date.now();
    flaps.push(flap);
    pruneOldFlaps(now);

    const withinCooldown = now - lastFiredAt < COOLDOWN_MS;
    if (flaps.length >= thresholdCount && !withinCooldown) {
      lastFiredAt = now;
      return [...flaps];
    }
    return null;
  }

  function currentWindow() {
    pruneOldFlaps(Date.now());
    return [...flaps];
  }

  return { recordFlap, currentWindow };
}

module.exports = { createPatternEngine };
