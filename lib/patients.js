/**
 * Single source of truth for the four demo patients.
 *
 * Pure data module — no fs or Node imports, so both server routes and
 * client components can import it. Consumers:
 *   app/ehr/page.jsx                     scenario cards + FHIR resource builders
 *   app/patient/page.jsx                 portal patient selector
 *   app/um/p2pExchange.jsx               member-match request builder
 *   app/api/patient-access/route.js      Patient/Coverage/EOB resources
 *   app/api/provider-access/route.js     attributed panel demographics
 *   app/api/payer-to-payer/*             subscriber map + prior plan history
 *   lib/seed.js                          replayed demo traffic
 */

export const PAYER_NAME = 'Blue Cross Blue Shield of Illinois';
export const BENEFIT_YEAR = '2026';

export const PATIENTS = {
  'pat-8849-jane-doe': {
    id: 'pat-8849-jane-doe',
    name: 'Jane Doe',
    family: 'Doe',
    given: ['Jane'],
    dob: '1972-04-14',
    gender: 'female',
    planType: 'COMM-PPO',
    planName: 'Commercial PPO',
    coverageId: 'cov-comm-ppo-bcbsil',
    subscriberId: 'BCBSIL-MEM-849',
    npi: '1234567890',
    practitioner: { id: 'pract-555-smith', family: 'Smith', given: ['Ada'] },
    currentPlanEobSummary: [
      { date: '2026-03-22', description: 'MRI Brain w/ and w/o Contrast', amount: 3950, memberOOP: 350 },
      { date: '2026-02-10', description: 'Office visit, established patient', amount: 210, memberOOP: 30 }
    ]
  },
  'pat-7712-robert-chen': {
    id: 'pat-7712-robert-chen',
    name: 'Robert Chen',
    family: 'Chen',
    given: ['Robert'],
    dob: '1955-09-22',
    gender: 'male',
    planType: 'MA-PPO',
    planName: 'Medicare Advantage PPO',
    coverageId: 'cov-ma-ppo-bcbsil',
    subscriberId: 'BCBSIL-MEM-712',
    npi: '1234567890',
    practitioner: { id: 'pract-555-smith', family: 'Smith', given: ['Ada'] },
    currentPlanEobSummary: [
      { date: '2026-05-12', description: 'Physical therapy, knee', amount: 420, memberOOP: 20 },
      { date: '2026-04-05', description: 'Annual wellness visit', amount: 180, memberOOP: 0 }
    ]
  },
  'pat-3301-dorothy-hayes': {
    id: 'pat-3301-dorothy-hayes',
    name: 'Dorothy Hayes',
    family: 'Hayes',
    given: ['Dorothy'],
    dob: '1948-03-07',
    gender: 'female',
    planType: 'COMM-PPO',
    planName: 'Commercial PPO',
    coverageId: 'cov-comm-ppo-bcbsil',
    subscriberId: 'BCBSIL-MEM-301',
    npi: 'GOLD-NPI-0001',
    practitioner: { id: 'pract-888-patel', family: 'Patel', given: ['Raj'] },
    currentPlanEobSummary: [
      { date: '2026-04-18', description: 'Knee X-ray, bilateral', amount: 340, memberOOP: 25 },
      { date: '2026-01-28', description: 'Orthopedic follow-up', amount: 260, memberOOP: 40 }
    ]
  },
  'pat-6614-marcus-johnson': {
    id: 'pat-6614-marcus-johnson',
    name: 'Marcus Johnson',
    family: 'Johnson',
    given: ['Marcus'],
    dob: '2014-11-19',
    gender: 'male',
    planType: 'COMM-HMO',
    planName: 'Commercial HMO',
    coverageId: 'cov-comm-hmo-bcbsil',
    subscriberId: 'BCBSIL-MEM-614',
    npi: '1234567890',
    practitioner: { id: 'pract-555-smith', family: 'Smith', given: ['Ada'] },
    currentPlanEobSummary: [
      { date: '2026-03-02', description: 'Pediatric psychiatry follow-up', amount: 310, memberOOP: 35 },
      { date: '2026-02-14', description: 'ABA therapy sessions, monthly', amount: 960, memberOOP: 50 }
    ]
  }
};

export const PATIENT_LIST = Object.values(PATIENTS);

export function getPatient(id) {
  return PATIENTS[id] || null;
}

export const PATIENT_ID_BY_SUBSCRIBER = Object.fromEntries(
  PATIENT_LIST.map((p) => [p.subscriberId, p.id])
);

// Static prior-plan seed data for the Payer-to-Payer demo.
// Each block represents coverage and PA history held by the member's prior
// payer before enrolling with BCBSIL.
export const PRIOR_PLAN_HISTORY = {
  'pat-8849-jane-doe': {
    priorPayer: 'Aetna',
    priorPlanId: 'AET-HMO-2025-COMM',
    priorPlanName: 'Aetna Commercial HMO',
    disenrollmentDate: '2025-12-31',
    priorPAs: [
      {
        authNumber: 'AET-2025-PA-88201',
        serviceCode: '70553',
        description: 'MRI Brain w/ and w/o Contrast',
        requestedDate: '2025-03-10',
        decisionDate: '2025-03-15',
        status: 'approved',
        approvedUnits: 1,
        expiryDate: '2025-09-15'
      },
      {
        authNumber: 'AET-2025-PA-00142',
        serviceCode: 'J9035',
        description: 'Bevacizumab (Avastin) infusion',
        requestedDate: '2025-01-05',
        decisionDate: '2025-01-08',
        status: 'denied',
        denialReason: 'Medical necessity criteria not met — alternative therapies not exhausted',
        denialCode: 'MN001',
        appealRights: 'Member may file a formal appeal within 60 days of denial notice.'
      }
    ],
    eobSummary: [
      { date: '2025-03-20', description: 'MRI Brain', amount: 3800, memberOOP: 320 },
      { date: '2025-05-14', description: 'Office visit, specialist', amount: 420, memberOOP: 45 }
    ]
  },
  'pat-7712-robert-chen': {
    priorPayer: 'UnitedHealthcare',
    priorPlanId: 'UHC-MA-PPO-2025',
    priorPlanName: 'UHC Medicare Advantage PPO',
    disenrollmentDate: '2025-12-31',
    priorPAs: [
      {
        authNumber: 'UHC-2025-PA-33771',
        serviceCode: '72141',
        description: 'MRI Spine Cervical w/o Contrast',
        requestedDate: '2025-06-08',
        decisionDate: '2025-06-10',
        status: 'approved',
        approvedUnits: 1,
        expiryDate: '2025-12-10'
      },
      {
        authNumber: 'UHC-2025-PA-19902',
        serviceCode: '27447',
        description: 'Total Knee Arthroplasty',
        requestedDate: '2025-04-18',
        decisionDate: '2025-04-22',
        status: 'approved',
        approvedUnits: 1,
        expiryDate: '2025-10-22'
      }
    ],
    eobSummary: [
      { date: '2025-06-15', description: 'MRI Cervical Spine', amount: 2100, memberOOP: 0 },
      { date: '2025-05-02', description: 'Orthopedic consultation', amount: 380, memberOOP: 0 }
    ]
  },
  'pat-3301-dorothy-hayes': {
    priorPayer: 'Humana',
    priorPlanId: 'HUM-MA-PPO-2025',
    priorPlanName: 'Humana Medicare Advantage PPO',
    disenrollmentDate: '2025-12-31',
    priorPAs: [
      {
        authNumber: 'HUM-2025-PA-55103',
        serviceCode: '27447',
        description: 'Total Knee Arthroplasty (right)',
        requestedDate: '2025-02-10',
        decisionDate: '2025-02-14',
        status: 'approved',
        approvedUnits: 1,
        expiryDate: '2025-08-14'
      },
      {
        authNumber: 'HUM-2025-PA-72240',
        serviceCode: '27130',
        description: 'Total Hip Arthroplasty',
        requestedDate: '2025-08-28',
        decisionDate: '2025-09-01',
        status: 'approved',
        approvedUnits: 1,
        expiryDate: '2026-03-01'
      }
    ],
    eobSummary: [
      { date: '2025-03-01', description: 'Total Knee Arthroplasty', amount: 28500, memberOOP: 1800 },
      { date: '2025-09-15', description: 'Total Hip Arthroplasty', amount: 31200, memberOOP: 1800 }
    ]
  },
  'pat-6614-marcus-johnson': {
    priorPayer: 'Cigna',
    priorPlanId: 'CIG-COMM-HMO-2025',
    priorPlanName: 'Cigna Commercial HMO',
    disenrollmentDate: '2025-12-31',
    priorPAs: [
      {
        authNumber: 'CIG-2025-PA-44821',
        serviceCode: '97153',
        description: 'Applied Behavior Analysis (ABA) Therapy',
        requestedDate: '2025-10-28',
        decisionDate: '2025-11-01',
        status: 'approved',
        approvedUnits: 40,
        unitType: 'hours/month',
        expiryDate: '2026-05-01'
      },
      {
        authNumber: 'CIG-2025-PA-30199',
        serviceCode: '90867',
        description: 'Transcranial Magnetic Stimulation (rTMS)',
        requestedDate: '2025-07-15',
        decisionDate: '2025-07-20',
        status: 'denied',
        denialReason: 'Not medically necessary — insufficient evidence for this age group',
        denialCode: 'MN003',
        appealRights: 'Member/guardian may file a formal appeal within 60 days of denial notice. External review available.'
      }
    ],
    eobSummary: [
      { date: '2025-11-10', description: 'ABA Therapy session (initial)', amount: 240, memberOOP: 25 },
      { date: '2025-12-01', description: 'Psychiatry evaluation', amount: 380, memberOOP: 40 }
    ]
  }
};
