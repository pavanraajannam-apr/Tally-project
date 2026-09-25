// Policy gate — decided inside the Tally tool, before anything is sent to
// Freshservice. The server side (Tally::TicketService::Create) trusts this
// decision rather than re-deriving it, same as the plan doc calls for.

function decideGate(diagnosis) {
  const autoFixable = Boolean(diagnosis.autoFixable) && diagnosis.confidence !== 'LOW';

  return {
    autoFixable,
    reason: autoFixable
      ? `Risk "${diagnosis.riskLevel}" and confidence ${diagnosis.confidence} — within auto-fix policy.`
      : `Risk "${diagnosis.riskLevel}" or confidence ${diagnosis.confidence} — routed for approval.`,
  };
}

module.exports = { decideGate };
