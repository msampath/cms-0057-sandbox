/**
 * Shared vendor-routing logic used by both the CRD order-sign service
 * and the PAS submit endpoint. Single source of truth for the oncology
 * conditional-routing rule.
 */

/**
 * ICD-10 codes from CRD order context (Condition resources the EHR sends
 * with the hook) or from a PAS Claim (Claim.diagnosis). R4 Patient has no
 * condition element, so neither is read from the Patient.
 */
export const ICD10CM = 'http://hl7.org/fhir/sid/icd-10-cm';

// The ICD-10-CM coding of a CodeableConcept, whatever else it carries.
export function icd10Code(cc) {
  const codings = Array.isArray(cc?.coding) ? cc.coding : [];
  const v = codings.find((c) => c?.system === ICD10CM)?.code;
  return typeof v === 'string' && v ? v : null;
}

export function conditionCodes(conditions) {
  return (Array.isArray(conditions) ? conditions : []).map((c) => icd10Code(c?.code)).filter(Boolean);
}

export function claimDiagnosisCodes(claim) {
  return (Array.isArray(claim?.diagnosis) ? claim.diagnosis : [])
    .map((d) => icd10Code(d?.diagnosisCodeableConcept))
    .filter(Boolean);
}

function hasOncologyCondition(diagnosisCodes) {
  return (diagnosisCodes || []).some((code) => {
    if (!code) return false;
    const first = code.charAt(0).toUpperCase();
    if (first === 'C') return true;
    if (first !== 'D') return false;
    const tens = parseInt(code.substring(1, 3), 10);
    return Number.isFinite(tens) && tens <= 49;
  });
}

/**
 * Pharmacy-benefit drug requests go to the PBM over NCPDP, not to the
 * medical UM vendors above. Prime Therapeutics is BCBSIL's PBM.
 */
export function resolvePharmacyRouting() {
  return { pbm: 'Prime Therapeutics', pbmId: 'PRIME-PBM' };
}

export function resolveRouting(rule, diagnosisCodes = []) {
  // A code with no grid rule needs no PA and stays with BCBSIL.
  if (!rule) return { vendor: 'BCBSIL', covered: 'covered' };
  if (rule.managed_by !== 'Carelon-or-BCBSIL-conditional') {
    return { vendor: rule.managed_by || 'BCBSIL', covered: 'covered' };
  }
  const oncology = hasOncologyCondition(diagnosisCodes);
  return {
    vendor: oncology ? 'Carelon' : 'BCBSIL',
    covered: 'covered',
    reason: oncology
      ? 'Patient has active oncology Condition (ICD-10 C00–D49); routed to Carelon.'
      : 'No oncology Condition present; routed to BCBSIL default UM.'
  };
}
