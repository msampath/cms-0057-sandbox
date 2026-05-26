// Mock staging data driven by uploaded PDF filenames.
// Each upload contributes the small curated rule set per pattern below.
// The bulk of demo rules comes from the pre-ingested snapshot in
// /data/preIngestedRules.json (loaded via the "Use previously ingested
// rules" button); subsequent uploads are intentionally small so the
// diff against the active DB is meaningful.

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

// Pattern order matters — `find` returns the first match. Specific labels
// (BH, Specialty Pharmacy, Medicare Advantage) must beat the generic
// `commercial` catch-all so a name like
// `2026-commercial-specialty-pharmacy-pacodelist.pdf` classifies as
// Specialty Pharmacy, not Commercial Med-Surg.
export const GRID_PATTERNS = [
  { matchers: [/\bbh\b/i, /behavioral/i, /mental.health/i], label: 'Behavioral Health', kind: 'bh', curated: RULES_BH },
  { matchers: [/specialty.*pharm/i, /pharmacy/i, /\bspecialty\b/i], label: 'Specialty Pharmacy', kind: 'pharm', curated: RULES_PHARM },
  { matchers: [/\bmapa\b/i, /medicare.?advantage/i, /\bma[-_ ]/i, /[-_ ]ma\b/i], label: 'Medicare Advantage', kind: 'ma', curated: RULES_MA },
  { matchers: [/commercial.*med.*surg/i, /med.*surg/i, /commercial/i], label: 'Commercial Med-Surg', kind: 'medsurg', curated: RULES_MEDSURG }
];

export const EXTRAS_RULES = [
  { match_type: 'code', service_code: '99214', description: 'Office Visit', pa_needed: 'no-auth', managed_by: 'BCBSIL', questionnaire_id: null, cql_library_id: null }
];

export function pickPatternForFile(name) {
  return GRID_PATTERNS.find((p) => p.matchers.some((m) => m.test(name))) || null;
}

/**
 * Returns:
 *   {
 *     rules:    deduplicated set (used for commit + aggregate KPIs)
 *     perFile:  one entry per uploaded file, with the rules that file
 *               contributed (NOT deduped across files) so every file
 *               appears in the per-source summary even if its rules
 *               were already claimed by a previous file.
 *   }
 */
export function buildStagedRules(files) {
  const byKey = new Map();
  const dedupedRules = [];
  const perFile = [];

  for (const f of files) {
    const pattern = pickPatternForFile(f.name);
    const label = pattern ? pattern.label : 'Other / unclassified';
    // Uploads contribute only the curated demo rules per pattern. The
    // bulk of rules comes from the pre-ingested snapshot loaded via the
    // "Use previously ingested rules" button.
    const baseRules = pattern ? pattern.curated : EXTRAS_RULES;
    const tagged = baseRules.map((r) => ({
      ...r,
      source_file: f.name,
      source_label: label
    }));

    const ownRules = []; // first-claimed rules; commit pulls from here
    const dupRules = []; // already claimed by an earlier file

    for (const r of tagged) {
      const key = `${r.match_type}|${r.service_code || ''}|${r.service_category || ''}`;
      if (!byKey.has(key)) {
        const entry = { ...r, also_in: [] };
        byKey.set(key, entry);
        dedupedRules.push(entry);
        ownRules.push(entry);
      } else {
        byKey.get(key).also_in.push(f.name);
        dupRules.push({ ...r });
      }
    }

    perFile.push({
      source_file: f.name,
      source_label: label,
      matched: Boolean(pattern),
      ownRules,
      dupRules,
      allRules: tagged
    });
  }

  return { rules: dedupedRules, perFile };
}

export function buildExceptions(rules, files) {
  const out = [
    { code: 'E0601', issue: 'Missing conditional parameter. Forced to fallback Questionnaire.' },
    { code: 'INVALID_X', issue: 'Failed FHIR ValueSet validation; will be quarantined on commit.' }
  ];
  const unmatched = files.filter((f) => !pickPatternForFile(f.name));
  if (unmatched.length > 0) {
    out.push({ code: 'UNMATCHED', issue: `${unmatched.length} uploaded file${unmatched.length === 1 ? '' : 's'} did not match a known grid pattern; treated as "Other / unclassified".` });
  }
  return out;
}

export function summarize(rules) {
  const total = rules.length;
  if (total === 0) return { total: 0, codeCount: 0, categoryCount: 0, codePct: 0, categoryPct: 0, authRate: 0, dtrCoverage: 0, routingPct: {} };
  const codeCount = rules.filter((r) => r.match_type === 'code').length;
  const categoryCount = rules.filter((r) => r.match_type === 'category').length;
  const authRate = Math.round((100 * rules.filter((r) => r.pa_needed === 'auth-needed').length) / total);
  const dtrCoverage = Math.round((100 * rules.filter((r) => r.questionnaire_id).length) / total);
  const routing = {};
  for (const r of rules) {
    const k = r.managed_by || 'unassigned';
    routing[k] = (routing[k] || 0) + 1;
  }
  const routingPct = Object.fromEntries(Object.entries(routing).map(([k, v]) => [k, Math.round((100 * v) / total)]));
  return {
    total,
    codeCount,
    categoryCount,
    codePct: Math.round((100 * codeCount) / total),
    categoryPct: Math.round((100 * categoryCount) / total),
    authRate,
    dtrCoverage,
    routingPct
  };
}

/**
 * Now takes the perFile array (every uploaded file, with own + dup splits)
 * and produces a display-friendly group list. Even files whose rules were
 * all duplicates appear, so reviewers see what every uploaded PDF brought.
 */
export function groupBySource(perFile) {
  return perFile.map((entry) => ({
    source_file: entry.source_file,
    source_label: entry.source_label,
    matched: entry.matched,
    rules: entry.allRules,
    ownCount: entry.ownRules.length,
    dupCount: entry.dupRules.length,
    metrics: summarize(entry.allRules)
  }));
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
