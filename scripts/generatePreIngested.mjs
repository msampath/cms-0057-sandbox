import { synthesize, SYNTH_COUNTS } from '../app/um/syntheticRules.js';
import fs from 'fs';

const RULES_MA = [
  { match_type: 'code', service_code: '99214', description: 'Office Visit', pa_needed: 'no-auth', managed_by: 'BCBSIL', questionnaire_id: null, cql_library_id: null },
  { match_type: 'code', service_code: '99213', description: 'Office Visit (low complexity)', pa_needed: 'no-auth', managed_by: 'BCBSIL', questionnaire_id: null, cql_library_id: null },
  { match_type: 'code', service_code: '36415', description: 'Routine venipuncture', pa_needed: 'no-auth', managed_by: 'BCBSIL', questionnaire_id: null, cql_library_id: null },
  { match_type: 'code', service_code: '70553', description: 'MRI Brain', pa_needed: 'auth-needed', managed_by: 'Carelon', questionnaire_id: 'advanced-imaging-medical-necessity', cql_library_id: 'advanced-imaging' },
  { match_type: 'code', service_code: '70471', description: 'CTA Head and Neck', pa_needed: 'auth-needed', managed_by: 'Carelon', questionnaire_id: 'advanced-imaging-medical-necessity', cql_library_id: 'advanced-imaging' }
];
const RULES_MEDSURG = [
  { match_type: 'code', service_code: '99214', description: 'Office Visit', pa_needed: 'no-auth', managed_by: 'BCBSIL', questionnaire_id: null, cql_library_id: null },
  { match_type: 'code', service_code: '90471', description: 'Immunization administration', pa_needed: 'no-auth', managed_by: 'BCBSIL', questionnaire_id: null, cql_library_id: null },
  { match_type: 'code', service_code: '80050', description: 'General health panel', pa_needed: 'no-auth', managed_by: 'BCBSIL', questionnaire_id: null, cql_library_id: null },
  { match_type: 'code', service_code: '15820', description: 'Revision of Lower Eyelid', pa_needed: 'auth-needed', managed_by: 'BCBSIL', questionnaire_id: 'blepharoplasty-medical-necessity', cql_library_id: 'blepharoplasty' },
  { match_type: 'code', service_code: '15822', description: 'Revision of Upper Eyelid', pa_needed: 'auth-needed', managed_by: 'BCBSIL', questionnaire_id: 'blepharoplasty-medical-necessity', cql_library_id: 'blepharoplasty' },
  { match_type: 'code', service_code: '19318', description: 'Reduction Mammoplasty', pa_needed: 'auth-needed', managed_by: 'BCBSIL', questionnaire_id: 'cosmetic-surgery-medical-necessity', cql_library_id: 'cosmetic-surgery' },
  { match_type: 'code', service_code: '15877', description: 'Suction Lipectomy Trunk', pa_needed: 'auth-needed', managed_by: 'BCBSIL', questionnaire_id: 'cosmetic-surgery-medical-necessity', cql_library_id: 'cosmetic-surgery' }
];
const RULES_PHARM = [
  { match_type: 'code', service_code: 'J9035', description: 'Avastin (bevacizumab)', pa_needed: 'auth-needed', managed_by: 'Carelon-or-BCBSIL-conditional', questionnaire_id: 'oncology-biologic-medical-necessity', cql_library_id: 'oncology-biologic' },
  { match_type: 'code', service_code: 'J9145', description: 'Darzalex (daratumumab)', pa_needed: 'auth-needed', managed_by: 'Carelon-or-BCBSIL-conditional', questionnaire_id: 'oncology-biologic-medical-necessity', cql_library_id: 'oncology-biologic' },
  { match_type: 'code', service_code: 'J0897', description: 'Denosumab', pa_needed: 'auth-needed', managed_by: 'BCBSIL', questionnaire_id: 'oncology-biologic-medical-necessity', cql_library_id: 'oncology-biologic' }
];
const RULES_BH = [
  { match_type: 'code', service_code: '90867', description: 'rTMS — Initial', pa_needed: 'auth-needed', managed_by: 'Lucet', questionnaire_id: 'rtms-medical-necessity', cql_library_id: 'rtms' },
  { match_type: 'category', service_code: null, service_category: 'Partial Hospitalization Treatment Program', description: 'PHP', pa_needed: 'auth-needed', managed_by: 'Lucet', questionnaire_id: 'fallback-medical-necessity', cql_library_id: null },
  { match_type: 'category', service_code: null, service_category: 'Applied Behavior Analysis (ABA)', description: 'ABA', pa_needed: 'auth-needed', managed_by: 'Lucet', questionnaire_id: 'aba-medical-necessity', cql_library_id: 'aba' },
  { match_type: 'category', service_code: null, service_category: 'Repetitive Transcranial Magnetic Stimulation (rTMS)', description: 'rTMS', pa_needed: 'auth-needed', managed_by: 'Lucet', questionnaire_id: 'rtms-medical-necessity', cql_library_id: 'rtms' }
];

const CANONICAL_GRIDS = [
  { name: '2026-ma-pa-codelist-q2.pdf', kind: 'ma', label: 'Medicare Advantage', curated: RULES_MA },
  { name: '2026-commercial-med-surg-pa-code-list.pdf', kind: 'medsurg', label: 'Commercial Med-Surg', curated: RULES_MEDSURG },
  { name: '2026-commercial-specialty-pharmacy-pacodelist.pdf', kind: 'pharm', label: 'Specialty Pharmacy', curated: RULES_PHARM },
  { name: '2026-commercial-bh-pa-codelist.pdf', kind: 'bh', label: 'Behavioral Health', curated: RULES_BH }
];

const byKey = new Map();
const rules = [];
const perFile = [];

for (const g of CANONICAL_GRIDS) {
  const tagged = [
    ...g.curated,
    ...synthesize(g.kind, SYNTH_COUNTS[g.kind] || 0, g.name)
  ].map((r) => ({ ...r, source_file: g.name, source_label: g.label }));

  let added = 0;
  for (const r of tagged) {
    const key = `${r.match_type}|${r.service_code || ''}|${r.service_category || ''}`;
    if (!byKey.has(key)) {
      byKey.set(key, true);
      rules.push(r);
      added++;
    }
  }
  perFile.push({ name: g.name, label: g.label, added, total: tagged.length });
}

const out = {
  generatedAt: new Date().toISOString(),
  perFile,
  totalRules: rules.length,
  rules
};

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/preIngestedRules.json', JSON.stringify(out, null, 2));
console.log('wrote data/preIngestedRules.json:', rules.length, 'rules');
console.log('perFile:', JSON.stringify(perFile, null, 2));
