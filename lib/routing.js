/**
 * Shared vendor-routing logic used by both the CRD order-sign service
 * and the PAS submit endpoint. Single source of truth for the oncology
 * conditional-routing rule.
 */

function hasOncologyCondition(patient) {
  const conditions = patient?.condition || [];
  return conditions.some((c) => {
    const code =
      c?.code?.coding?.[0]?.code ||
      c?.code?.text ||
      (typeof c === 'string' ? c : '');
    if (!code) return false;
    const first = code.charAt(0).toUpperCase();
    if (first === 'C') return true;
    if (first !== 'D') return false;
    const tens = parseInt(code.substring(1, 3), 10);
    return Number.isFinite(tens) && tens <= 49;
  });
}

export function resolveRouting(rule, patient) {
  if (!rule) return { vendor: 'BCBSIL', covered: 'not-covered' };
  if (rule.managed_by !== 'Carelon-or-BCBSIL-conditional') {
    return { vendor: rule.managed_by, covered: 'covered' };
  }
  const oncology = hasOncologyCondition(patient);
  return {
    vendor: oncology ? 'Carelon' : 'BCBSIL',
    covered: 'covered',
    reason: oncology
      ? 'Patient has active oncology Condition (ICD-10 C00–D49); routed to Carelon.'
      : 'No oncology Condition present; routed to BCBSIL default UM.'
  };
}
