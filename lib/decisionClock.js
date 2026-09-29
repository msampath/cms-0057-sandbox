/**
 * Legal decision clocks for prior authorization (CMS-0062-P position 3).
 *
 * Pure data and functions, so client components can import it. The demo's
 * 8-second review window in lib/pendedReview.js is separate: it decides
 * when the sandbox finalizes a pend. This module computes when the law
 * says the decision is due, and on what basis.
 *
 * Sources: CMS-0057-F (non-drug items), SSA 1927(d)(5) and 42 CFR
 * 438.3(s)(6) (Medicaid covered outpatient drugs), existing 42 CFR 422.568
 * and 422.572 (MA Part B drugs), and CMS-0062-P as proposed (QHP drugs).
 * Commercial employer coverage is not an impacted payer under these rules.
 */

const HOUR = 3600 * 1000;

// Keys are plan types used across the sandbox (lib/patients.js).
const CLOCKS = {
  'MEDICAID-MCO': {
    drug: {
      expeditedHours: 24,
      standardHours: 24,
      basis: 'SSA 1927(d)(5)(A); 42 CFR 438.3(s)(6), 438.210(d)(3)',
      note: 'One 24-hour clock for covered outpatient drugs, with no expedited or standard split.',
      emergencySupply: 'A 72-hour emergency supply must be dispensable while the request is pending (SSA 1927(d)(5)(B)).'
    },
    item: {
      expeditedHours: 72,
      standardHours: 7 * 24,
      basis: 'CMS-0057-F, 42 CFR 438.210(d)'
    }
  },
  'QHP-FFE': {
    drug: {
      expeditedHours: 24,
      standardHours: 72,
      basis: 'Proposed 45 CFR 156.223(i)(1) (CMS-0062-P)',
      proposed: true
    },
    item: null,
    itemNote: 'CMS-0057-F decision timeframes did not extend to QHP issuers on the FFEs.'
  },
  'MA-PPO': {
    // Medical benefit is Part B. The pharmacy benefit is Part D, whose
    // coverage determinations have their own sections.
    drug: {
      expeditedHours: 24,
      standardHours: 72,
      basis: '42 CFR 422.568(b)(3), 422.572(a)(2) (Part B drugs)'
    },
    pharmacyDrug: {
      expeditedHours: 24,
      standardHours: 72,
      basis: '42 CFR 423.568(b), 423.572(a) (Part D coverage determinations)',
      note: 'MA-PD pharmacy benefit (Part D). CMS-0062-P does not extend its NCPDP requirement to MA, which already follows 42 CFR 423.160.'
    },
    item: {
      expeditedHours: 72,
      standardHours: 7 * 24,
      basis: 'CMS-0057-F, 42 CFR 422.568(b)(1), 422.572(a)(1)'
    }
  }
};

const NOT_IMPACTED =
  'Commercial employer coverage is not an impacted payer under CMS-0057-F or CMS-0062-P, so no federal decision clock applies.';

/**
 * Decision clock for a request.
 *   planType   'COMM-PPO' | 'COMM-HMO' | 'MA-PPO' | 'MEDICAID-MCO' | 'QHP-FFE'
 *   isDrug     drug (true) or non-drug item or service (false)
 *   benefit    'medical' (default) or 'pharmacy', for drugs
 *   expedited  expedited (urgent) request
 *   receivedAt ISO time the request was received (defaults to now)
 * Returns { applies, hours, kind, receivedAt, dueAt, basis, proposed, note,
 * emergencySupply }.
 */
export function decisionClock({ planType, isDrug, benefit = 'medical', expedited = false, receivedAt }) {
  const plan = typeof planType === 'string' && Object.hasOwn(CLOCKS, planType) ? CLOCKS[planType] : null;
  if (!plan) return { applies: false, note: NOT_IMPACTED };
  const rule = !isDrug ? plan.item : benefit === 'pharmacy' && plan.pharmacyDrug ? plan.pharmacyDrug : plan.drug;
  if (!rule) return { applies: false, note: plan.itemNote };
  const hours = expedited ? rule.expeditedHours : rule.standardHours;
  // An unparseable receivedAt (for example from a client) falls back to now
  // rather than throwing on toISOString().
  const parsed = receivedAt ? Date.parse(receivedAt) : NaN;
  const start = Number.isFinite(parsed) ? parsed : Date.now();
  return {
    applies: true,
    hours,
    kind: expedited ? 'expedited' : 'standard',
    receivedAt: new Date(start).toISOString(),
    dueAt: new Date(start + hours * HOUR).toISOString(),
    basis: rule.basis,
    proposed: !!rule.proposed,
    note: rule.note || null,
    emergencySupply: rule.emergencySupply || null
  };
}

/** "72 hours" or "7 calendar days". */
export function formatClockHours(hours) {
  return hours % 24 === 0 && hours >= 7 * 24 ? `${hours / 24} calendar days` : `${hours} hours`;
}
