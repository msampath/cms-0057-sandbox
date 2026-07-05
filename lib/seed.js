import { resolveRouting } from './routing';
import { getPatient } from './patients';
import { PAS_PROFILES } from './fhir';
import {
  generateX12_278,
  generateX12_278_Response,
  getReceiverId
} from '../app/api/pas/x12Generator';

/**
 * First-boot demo seed.
 *
 * buildSeedEntries(db) returns a chronological (oldest-first) list of
 * transaction-log entries replaying three completed scenarios, so the first
 * visitor sees a working Live Feed, Provider Access panel, and Patient
 * portal without running the EHR flow first. lib/db.js ensureSeeded() calls
 * this when the log is empty; the rule-snapshot load itself lives in db.js
 * (it owns fs access).
 *
 * Entries mirror the exact strings and structured payloads the real
 * order-sign and pas/submit routes emit — including the structured
 * X12 278 REQUEST entry, generated through the real generateX12_278() so
 * the FHIR ↔ X12 translator drawer opens on seeded traffic. Every entry
 * carries `seeded: true` plus a back-dated `timestamp` in meta.
 *
 * Import direction is one-way (db.js → seed.js → routing / x12Generator);
 * seed.js must never import db.js.
 */

const CRD_TEMP = 'http://hl7.org/fhir/us/davinci-crd/CodeSystem/temp';
const COV_EXT =
  'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information';
const CPT = 'http://www.ama-assn.org/go/cpt';

// Fallbacks keep seeding functional if the snapshot is absent or trimmed.
const FALLBACK_RULES = {
  '70553': {
    match_type: 'code',
    service_code: '70553',
    description: 'MRI Brain w/ and w/o Contrast',
    pa_needed: 'auth-needed',
    managed_by: 'Carelon',
    documentation_requirements: ''
  },
  '27447': {
    match_type: 'code',
    service_code: '27447',
    description: 'Total Knee Arthroplasty',
    pa_needed: 'auth-needed',
    managed_by: 'Carelon',
    documentation_requirements: ''
  },
  aba: {
    match_type: 'category',
    service_category: 'Applied Behavior Analysis (ABA)',
    description: 'Applied Behavior Analysis (ABA)',
    pa_needed: 'auth-needed',
    managed_by: 'Lucet',
    documentation_requirements: ''
  }
};

// Same plan filter the CRD engine applies for COMM-* plans: drop MA rules.
function commRules(db) {
  return (db.rules || []).filter(
    (r) => !(r.source_label || '').toLowerCase().includes('medicare')
  );
}

function findCodeRule(db, code) {
  return (
    commRules(db).find(
      (r) => r.match_type === 'code' && r.service_code === code
    ) || FALLBACK_RULES[code]
  );
}

function findAbaRule(db) {
  return (
    commRules(db).find(
      (r) =>
        r.match_type === 'category' &&
        (r.service_category || '').toLowerCase().includes('applied behavior')
    ) || FALLBACK_RULES.aba
  );
}

// Mirrors pickIndicator() in order-sign (sans hard-stop / gold-card inputs).
function indicatorFor(rule) {
  if (!rule) return 'warning';
  if (rule.pa_needed === 'no-auth') return 'info';
  const docs = rule.documentation_requirements || '';
  const highComplexity =
    rule.managed_by === 'Carelon-or-BCBSIL-conditional' ||
    /functional impairment/i.test(docs);
  return highComplexity ? 'critical' : 'warning';
}

// Mirrors buildCoverageInformationAction() in order-sign (status 'ready',
// includes the #coverage extension).
function crdCoverageTask({ patientId, coverageId, code, authoredOn }) {
  const ext = [
    {
      url: `${COV_EXT}#coverage`,
      valueReference: { reference: `Coverage/${coverageId}` }
    },
    { url: `${COV_EXT}#covered`, valueCode: 'covered' },
    { url: `${COV_EXT}#pa-needed`, valueCode: 'auth-needed' }
  ];
  const billing = { system: CPT };
  if (code) billing.code = code;
  ext.push({ url: `${COV_EXT}#billingCode`, valueCoding: billing });
  ext.push({ url: `${COV_EXT}#date`, valueDateTime: authoredOn });
  return {
    resourceType: 'Task',
    status: 'ready',
    intent: 'proposal',
    code: { coding: [{ system: CRD_TEMP, code: 'coverage-information' }] },
    for: { reference: `Patient/${patientId}` },
    authoredOn,
    extension: ext
  };
}

// Mirrors the satisfied Task emitted by pas/submit (status 'completed',
// no #coverage extension, carries #satisfied-pa-id).
function pasSatisfiedTask({ patientId, code, authNumber, authoredOn }) {
  return {
    resourceType: 'Task',
    status: 'completed',
    intent: 'proposal',
    code: { coding: [{ system: CRD_TEMP, code: 'coverage-information' }] },
    for: { reference: `Patient/${patientId}` },
    authoredOn,
    extension: [
      { url: `${COV_EXT}#covered`, valueCode: 'covered' },
      { url: `${COV_EXT}#pa-needed`, valueCode: 'satisfied' },
      {
        url: `${COV_EXT}#billingCode`,
        valueCoding: { system: CPT, code: code || '' }
      },
      { url: `${COV_EXT}#date`, valueDateTime: authoredOn },
      { url: `${COV_EXT}#satisfied-pa-id`, valueString: authNumber }
    ]
  };
}

export function buildSeedEntries(db) {
  const base = Date.now();
  const at = (minAgo, secOffset = 0) =>
    new Date(base - minAgo * 60000 + secOffset * 1000).toISOString();
  const meta = (extra, minAgo, secOffset) => ({
    ...extra,
    seeded: true,
    timestamp: at(minAgo, secOffset)
  });

  const entries = [];
  const add = (actor, action, details, m) =>
    entries.push({ actor, action, details, meta: m });

  // ---- Marcus Johnson — ABA category match, CRD only (21 min ago) --------
  {
    const marcus = getPatient('pat-6614-marcus-johnson');
    const patientId = marcus.id;
    const npi = marcus.npi;
    const rule = findAbaRule(db);
    const vendor = resolveRouting(rule, null).vendor;
    add(
      'CRD Gateway',
      'HOOK RECEIVED',
      `order-sign for Patient/${patientId}, code=—, category=Applied Behavior Analysis (ABA)`,
      meta({ npi, patientId, code: null }, 21, 0)
    );
    add(
      'CRD Gateway',
      'COVERAGE-INFORMATION ACTION',
      JSON.stringify(
        crdCoverageTask({
          patientId,
          coverageId: marcus.coverageId,
          code: null,
          authoredOn: at(21, 1)
        }),
        null,
        2
      ),
      meta({ npi, patientId, code: null }, 21, 1)
    );
    add(
      'CRD Engine',
      'EVALUATION',
      `pass=category code=— rule=${rule.description || rule.service_category} indicator=${indicatorFor(rule)} routed=${vendor}`,
      meta({ npi, patientId, code: null }, 21, 2)
    );
  }

  // ---- Dorothy Hayes — 27447 gold-card exemption, CRD only (14 min ago) --
  {
    const dorothy = getPatient('pat-3301-dorothy-hayes');
    const patientId = dorothy.id;
    const npi = dorothy.npi;
    const code = '27447';
    const rule = findCodeRule(db, code);
    const vendor = resolveRouting(rule, null).vendor;
    add(
      'CRD Gateway',
      'HOOK RECEIVED',
      `order-sign for Patient/${patientId}, code=${code}, category=—`,
      meta({ npi, patientId, code }, 14, 0)
    );
    add(
      'CRD Gateway',
      'COVERAGE-INFORMATION ACTION',
      JSON.stringify(
        crdCoverageTask({
          patientId,
          coverageId: dorothy.coverageId,
          code,
          authoredOn: at(14, 1)
        }),
        null,
        2
      ),
      meta({ npi, patientId, code }, 14, 1)
    );
    add(
      'CRD Engine',
      'EVALUATION',
      `pass=code code=${code} rule=${rule.description} indicator=info routed=${vendor}`,
      meta({ npi, patientId, code }, 14, 2)
    );
  }

  // ---- Jane Doe — 70553 full CRD → PAS arc (6 min ago) --------------------
  {
    const jane = getPatient('pat-8849-jane-doe');
    const patientId = jane.id;
    const coverageId = jane.coverageId;
    const npi = jane.npi;
    const code = '70553';
    const rule = findCodeRule(db, code);
    const patient = {
      resourceType: 'Patient',
      id: patientId,
      name: [{ family: jane.family, given: jane.given }],
      gender: jane.gender,
      birthDate: jane.dob,
      condition: []
    };
    const vendor = resolveRouting(rule, patient).vendor;
    const authNumber = `AUTH${String(base).slice(-7)}`;

    // CRD leg
    add(
      'CRD Gateway',
      'HOOK RECEIVED',
      `order-sign for Patient/${patientId}, code=${code}, category=—`,
      meta({ npi, patientId, code }, 6, 0)
    );
    add(
      'CRD Gateway',
      'COVERAGE-INFORMATION ACTION',
      JSON.stringify(
        crdCoverageTask({ patientId, coverageId, code, authoredOn: at(6, 1) }),
        null,
        2
      ),
      meta({ npi, patientId, code }, 6, 1)
    );
    add(
      'CRD Engine',
      'EVALUATION',
      `pass=code code=${code} rule=${rule.description} indicator=${indicatorFor(rule)} routed=${vendor}`,
      meta({ npi, patientId, code }, 6, 2)
    );

    // PAS leg — same Bundle shape the EHR submits.
    const bundle = {
      resourceType: 'Bundle',
      meta: { profile: [PAS_PROFILES.requestBundle] },
      type: 'collection',
      entry: [
        { resource: patient },
        {
          resource: {
            resourceType: 'Coverage',
            id: coverageId,
            status: 'active',
            subscriberId: jane.subscriberId,
            payor: [{ identifier: { value: 'BCBSIL' } }]
          }
        },
        {
          resource: {
            resourceType: 'Practitioner',
            id: jane.practitioner.id,
            name: [{ family: jane.practitioner.family, given: jane.practitioner.given }],
            identifier: [
              { system: 'http://hl7.org/fhir/sid/us-npi', value: npi }
            ]
          }
        },
        {
          resource: {
            resourceType: 'Claim',
            id: `claim-${base - 270000}`,
            status: 'active',
            use: 'preauthorization',
            patient: { reference: `Patient/${patientId}` },
            item: [
              {
                sequence: 1,
                productOrService: {
                  coding: [{ system: CPT, code }]
                }
              }
            ],
            servicedDate: at(4.5, 0).slice(0, 10)
          }
        },
        {
          resource: {
            resourceType: 'QuestionnaireResponse',
            id: `qr-${base - 270000}`,
            questionnaire:
              'http://payer.bcbsil.example/Questionnaire/advanced-imaging-medical-necessity|1.0.0',
            status: 'completed',
            subject: { reference: `Patient/${patientId}` },
            item: [
              {
                linkId: 'clinical-indication',
                text: 'Primary clinical indication',
                answer: [
                  {
                    valueString:
                      'Chronic headache with new focal neurologic deficit'
                  }
                ]
              },
              {
                linkId: 'prior-imaging',
                text: 'Prior imaging performed within 6 months',
                answer: [{ valueBoolean: false }]
              }
            ]
          }
        }
      ],
      serviceCategory: null,
      planType: 'COMM-PPO',
      _simulateDenial: false
    };

    add(
      'PAS Gateway',
      'BUNDLE RECEIVED',
      `FHIR Bundle (type=${bundle.type}) for Patient/${patientId}, code=${code}. Bundle preserved unaltered.`,
      meta({ patientId }, 4.5, 0)
    );

    try {
      const { x12, mappings } = generateX12_278({
        bundle,
        rule,
        vendor,
        orderedCode: code
      });
      add(
        'PAS Gateway',
        'X12 278 REQUEST',
        {
          kind: 'fhir-x12-translation',
          vendor,
          bundle,
          x12,
          mappings,
          note: 'Bundle preserved unaltered; X12 is a parallel projection for the legacy adjudication engine.'
        },
        meta({ patientId }, 4.5, 1)
      );
    } catch {
      // A malformed generator input should never block the rest of the seed.
    }

    add(
      'Legacy UM Mainframe',
      'X12 278 RESPONSE',
      `Decision: APPROVED. Auth # ${authNumber}.\n\n${generateX12_278_Response({
        receiverId: getReceiverId(vendor),
        authNumber
      })}`,
      meta({ patientId }, 4.5, 4)
    );
    add(
      'PAS Gateway',
      'COVERAGE-INFORMATION ACTION',
      JSON.stringify(
        pasSatisfiedTask({
          patientId,
          code,
          authNumber,
          authoredOn: at(4.5, 5)
        }),
        null,
        2
      ),
      meta({ patientId }, 4.5, 5)
    );
    add(
      'PAS Translator',
      'FHIR RESPONSE',
      `ClaimResponse synthesised from preserved Bundle + auth # ${authNumber} (no FHIR→X12→FHIR round-trip).`,
      meta({ patientId }, 4.5, 6)
    );
  }

  return entries;
}
