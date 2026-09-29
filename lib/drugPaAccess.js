import { listDrugPaRecords } from './db';
import { DRUG_CATALOG, DRUG_DENIAL_REASONS } from './drugPa';
import { buildPriorAuthEob } from './eob';
import { getPatient, PAYER_NAME } from './patients';

/**
 * Drug prior authorizations for the access APIs (CMS-0062-P removes the
 * CMS-0057-F drug exclusion from Patient Access, Provider Access, and
 * Payer-to-Payer). One PDex Prior Authorization EOB per benefit track on
 * each shared drug PA record.
 *
 * Track entries that are not decisions by the shared model are left out:
 * a forced debug denial (debugForced) and a PAS Bundle with no DTR answers
 * (noAnswers). Server-only (reads the in-memory store).
 */
export function drugPriorAuthEobs(patientId) {
  const member = getPatient(patientId);
  const coverageRef = `Coverage/${member?.coverageId || `cov-${patientId}`}`;
  const practitionerRef = `Practitioner/${member?.practitioner?.id || 'unknown'}`;
  return listDrugPaRecords(patientId).flatMap((record) => {
    const drug = DRUG_CATALOG[record.drugKey];
    if (!drug) return [];
    return Object.entries(record.tracks || {})
      .filter(([, t]) => t.determination && !t.debugForced && !t.noAnswers)
      .map(([track, t]) =>
        buildPriorAuthEob({
          record,
          track,
          drug,
          // Each track keeps its own reason, so a later decision on the
          // other track cannot rewrite this one.
          reason: t.determination === 'denied' && t.reasonKey ? DRUG_DENIAL_REASONS[t.reasonKey] : null,
          coverageRef,
          payerDisplay: PAYER_NAME,
          practitionerRef
        })
      );
  });
}
