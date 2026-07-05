import fs from 'fs';
import path from 'path';
import { buildSeedEntries } from './seed';

const dbPath = path.join(process.cwd(), 'database.json');
const snapshotPath = path.join(process.cwd(), 'data', 'preIngestedRules.json');

/**
 * CRD data model — seven sections plus a runtime transaction log.
 *
 *   payer               One block: organization identity + default contact.
 *   plans               Plan taxonomy. PA defaults, benefit period, OON rule,
 *                       blanket exemptions live here.
 *   network_tiers       Tier definitions with provider NPI/TIN lists and
 *                       per-tier PA exemptions.
 *   service_categories  Code groupings with a category-default rule used
 *                       when no code-specific rule matches.
 *   rules               Per (plan_type + service_code) PA determinations.
 *   questionnaires      Registry of DTR Questionnaire canonical URLs.
 *   gold_card_programs  Provider-level PA exemptions (pa_needed=satisfied).
 *
 * Rule shape (all fields optional unless marked *):
 *   * match_type:       "code" | "category"
 *   * service_code:     CPT/HCPCS/J-code (when match_type === "code")
 *     service_category: free-text category (when match_type === "category")
 *     code_system:      FHIR CodeSystem URI (cpt/hcpcs/rxnorm/icd-10)
 *   * description
 *   * pa_needed:        "no-auth" | "auth-needed" | "performpa" | "satisfied"
 *     covered:          "covered" | "not-covered" | "conditional" | "indeterminate"
 *   * managed_by:       routing vendor
 *     plan_type:        which plan(s) this applies to
 *     documentation:    { type, purpose, questionnaire } when DTR launch needed
 *     condition:        { type, params } when covered === "conditional"
 *     info_needed:      ["performer"|"location"|"timeframe"|"contract-window"|"detail-code"]
 *     reason:           { code, text } when not-covered/indeterminate/satisfied
 *     formulary:        { tier, specialty, quantity_limit, preferred_alternatives, site_of_care, prior_fill_required }
 *     contact:          { name, phone, url, fax, hours } overrides plan-level
 *     billing_code_override: "system|code" alternative billing code
 *     expiry_days:      determination validity period
 *     network_dependency: "in-network-only" | "out-of-network-only" | "both" | "none"
 *     effective_date / termination_date: ISO dates
 *     source_file / source_label / source_page: provenance from ingestion
 */

const CODE_SYSTEMS = {
  CPT:    'http://www.ama-assn.org/go/cpt',
  HCPCS:  'https://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets',
  ICD10:  'http://hl7.org/fhir/sid/icd-10-cm',
  RxNorm: 'http://www.nlm.nih.gov/research/umls/rxnorm',
  NDC:    'http://hl7.org/fhir/sid/ndc'
};

const defaultData = {
  payer: {
    id: 'BCBSIL',
    name: 'Blue Cross Blue Shield of Illinois',
    contact: {
      name: 'Prior Auth Help Desk',
      phone: '1-800-572-3009',
      url: 'https://www.bcbsil.com/provider/clinical/prior-auth'
    }
  },

  plans: [
    {
      plan_type: 'COMM-PPO',
      name: 'Commercial PPO (incl. Blue Choice / Blue Options / Blue HPN)',
      requires_pa_by_default: false,
      benefit_period: 'calendar_year',
      blanket_exemptions: [
        'Preventive services (USPSTF A/B)',
        'Emergency services',
        'Urgent care'
      ],
      oon_rule: 'In- and out-of-network; OON subject to higher cost share',
      contact: {
        name: 'Commercial Member Services',
        phone: '1-800-538-8833',
        url: 'https://www.bcbsil.com/provider'
      }
    },
    {
      plan_type: 'COMM-HMO',
      name: 'Commercial HMO',
      requires_pa_by_default: true,
      benefit_period: 'calendar_year',
      blanket_exemptions: [
        'Preventive services (USPSTF A/B)',
        'Emergency services'
      ],
      oon_rule: 'In-network only; OON covered in emergency only',
      contact: {
        name: 'HMO Member Services',
        phone: '1-800-892-2803',
        url: 'https://www.bcbsil.com/provider'
      }
    },
    {
      plan_type: 'MA-PPO',
      name: 'Medicare Advantage PPO',
      requires_pa_by_default: false,
      benefit_period: 'calendar_year',
      blanket_exemptions: [
        'Preventive services (USPSTF A/B)',
        'Emergency services',
        'Urgent care'
      ],
      oon_rule: 'In- and out-of-network; OON subject to higher cost share',
      contact: {
        name: 'Medicare Advantage Provider Services',
        phone: '1-877-774-8592',
        url: 'https://www.bcbsil.com/provider'
      }
    }
  ],

  network_tiers: [
    {
      tier_name: 'Tier 1 — Preferred / Centers of Excellence',
      tier_code: 'T1',
      description: 'Centers of Excellence and highest-performing providers; reduced PA burden for select procedure clusters.',
      providers: [],
      tins: [],
      pa_exemptions: [],
      applies_to_plans: ['COMM-PPO', 'COMM-HMO']
    },
    {
      tier_name: 'Tier 2 — Standard Network',
      tier_code: 'T2',
      description: 'Contracted in-network providers without preferred status.',
      providers: [],
      tins: [],
      pa_exemptions: [],
      applies_to_plans: ['COMM-PPO', 'COMM-HMO', 'MA-PPO']
    }
  ],

  service_categories: [
    {
      category_id: 'advanced-imaging',
      category_name: 'Advanced Imaging',
      description: 'CT, MRI, PET scans requiring clinical indication.',
      codes: [],
      default_rule: {
        covered: 'covered',
        pa_needed: 'auth-needed',
        documentation: { type: 'clinical', purpose: 'withpa' }
      }
    },
    {
      category_id: 'specialty-pharmacy',
      category_name: 'Specialty Pharmacy (infusion / provider-administered)',
      description: 'Specialty drug therapies including infusion site-of-care and cellular/gene therapy.',
      codes: [],
      default_rule: {
        covered: 'covered',
        pa_needed: 'auth-needed',
        documentation: { type: 'clinical', purpose: 'withpa' }
      }
    },
    {
      category_id: 'behavioral-health',
      category_name: 'Behavioral Health',
      description: 'Outpatient mental-health and substance-use treatment categories.',
      codes: [],
      default_rule: {
        covered: 'covered',
        pa_needed: 'auth-needed',
        documentation: { type: 'clinical', purpose: 'withpa' }
      }
    }
  ],

  rules: [],

  questionnaires: [
    { id: 'blepharoplasty-medical-necessity',         canonical_url: 'http://payer.bcbsil.example/Questionnaire/blepharoplasty-medical-necessity|1.0.0',         version: '1.0.0', topic: 'oculoplastic-surgery',  purpose: 'withpa', covers_services: [] },
    { id: 'cosmetic-surgery-medical-necessity',       canonical_url: 'http://payer.bcbsil.example/Questionnaire/cosmetic-surgery-medical-necessity|1.0.0',       version: '1.0.0', topic: 'plastic-surgery',      purpose: 'withpa', covers_services: [] },
    { id: 'oncology-biologic-medical-necessity',      canonical_url: 'http://payer.bcbsil.example/Questionnaire/oncology-biologic-medical-necessity|1.0.0',      version: '1.0.0', topic: 'oncology-biologic',    purpose: 'withpa', covers_services: [] },
    { id: 'advanced-imaging-medical-necessity',       canonical_url: 'http://payer.bcbsil.example/Questionnaire/advanced-imaging-medical-necessity|1.0.0',       version: '1.0.0', topic: 'advanced-imaging',     purpose: 'withpa', covers_services: [] },
    { id: 'aba-medical-necessity',                    canonical_url: 'http://payer.bcbsil.example/Questionnaire/aba-medical-necessity|1.0.0',                    version: '1.0.0', topic: 'behavioral-health',    purpose: 'withpa', covers_services: [] },
    { id: 'rtms-medical-necessity',                   canonical_url: 'http://payer.bcbsil.example/Questionnaire/rtms-medical-necessity|1.0.0',                   version: '1.0.0', topic: 'behavioral-health',    purpose: 'withpa', covers_services: [] },
    { id: 'fallback-medical-necessity',               canonical_url: 'http://payer.bcbsil.example/Questionnaire/fallback-medical-necessity|1.0.0',               version: '1.0.0', topic: 'general',              purpose: 'withpa', covers_services: [] }
  ],

  gold_card_programs: [
    {
      program_name: 'Orthopedic Gold Card',
      eligibility: 'Providers with >95% PA approval rate on TKA/THA over trailing 12 months.',
      provider_scope: 'NPI list maintained by payer, refreshed quarterly',
      providers: ['GOLD-NPI-0001'],
      code_scope: ['27447', '27130', '27125'],
      code_system: CODE_SYSTEMS.CPT,
      exemption_type: 'full-auto-approval',
      effective_date: '2026-01-01'
    },
    {
      program_name: 'Advanced Imaging Gold Card',
      eligibility: 'Imaging facilities with >97% appropriate-use score per Carelon analytics.',
      provider_scope: 'TIN list maintained by Carelon, refreshed quarterly',
      // Must be non-empty: the CRD engine treats an empty providers list as a
      // program-wide pilot and would gold-card every 70553 order, which
      // silently removes the demo's flagship CRD → DTR → PAS arc on any
      // fresh database. No demo scenario uses this sentinel NPI.
      providers: ['IMG-GOLD-NPI-0001'],
      code_scope: ['70553', '70551', '72148', '72141'],
      code_system: CODE_SYSTEMS.CPT,
      exemption_type: 'full-auto-approval',
      effective_date: '2026-01-01'
    }
  ],

  transactionLog: []
};

// Module-level cache — populated on first getDb() call, invalidated on saveDb().
// Next.js reuses module instances across requests in the same server process.
let _cache = null;

// In-memory transaction log — never persisted to disk. Ephemeral by design.
let _log = [];

// In-memory pending PA requests — keyed by auth number. Never persisted.
const _pending = new Map();

// First-touch demo seeding. `_seeded` makes the attempt once per process;
// `_emptyLatch` is set when an operator resets to the empty state so the
// lazy seed does not immediately refill it (cleared on process restart or
// a seeded reset).
let _seeded = false;
let _emptyLatch = false;

function ensureSeeded() {
  if (_seeded || _emptyLatch) return;
  _seeded = true; // set first — getDb()/getLog() below re-enter this guard
  const logWasEmpty = _log.length === 0;
  const db = getDb();

  let seededRuleCount = 0;
  let snapshotStamp = null;
  if (!db.rules.length && fs.existsSync(snapshotPath)) {
    try {
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      db.rules = snapshot.rules || [];
      seededRuleCount = db.rules.length;
      snapshotStamp = snapshot.generatedAt;
      saveDb(db);
    } catch {
      // A corrupted snapshot must not take the app down; the UM upload
      // and load-pre-ingested paths still work.
    }
  }

  if (logWasEmpty) {
    try {
      for (const e of buildSeedEntries(db)) {
        logTransaction(e.actor, e.action, e.details, e.meta);
      }
    } catch {
      // Seeded traffic is a convenience — never fatal.
    }
  }

  if (seededRuleCount) {
    logTransaction(
      'Ingestion Engine',
      'STATE COMMIT',
      `Auto-seeded ${seededRuleCount} pre-ingested rules at boot (snapshot @ ${snapshotStamp}). Live feed shows replayed demo traffic; run an order from /ehr to add your own.`,
      { seeded: true }
    );
  }
}

export { CODE_SYSTEMS };

export function getDb() {
  ensureSeeded();
  if (_cache) return _cache;
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify(defaultData, null, 2));
    _cache = { ...defaultData };
  } else {
    const onDisk = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    _cache = {
      ...defaultData,
      ...onDisk,
      rules: onDisk.rules || []
    };
    // If on-disk gold_card_programs have empty providers (written before this
    // field was populated), backfill from defaultData so demo scenarios work.
    if (_cache.gold_card_programs) {
      const defByName = new Map(
        defaultData.gold_card_programs.map((g) => [g.program_name, g])
      );
      _cache.gold_card_programs = _cache.gold_card_programs.map((g) => {
        const def = defByName.get(g.program_name);
        return !g.providers?.length && def?.providers?.length
          ? { ...g, providers: def.providers }
          : g;
      });
    }
  }
  return _cache;
}

export function saveDb(data) {
  _cache = data;
  // transactionLog is ephemeral — never written to disk.
  const { transactionLog: _ignored, ...toWrite } = data;
  fs.writeFileSync(dbPath, JSON.stringify(toWrite, null, 2));
}

export function getLog() {
  ensureSeeded();
  return _log;
}

export function clearLog() {
  const count = _log.length;
  _log = [];
  return count;
}

export function addPendingRequest(id, data) {
  _pending.set(id, { ...data, status: 'pended' });
}

export function getPendingRequest(id) {
  return _pending.get(id) || null;
}

export function finalizePendingRequest(id, update) {
  const existing = _pending.get(id);
  if (!existing) return false;
  _pending.set(id, { ...existing, ...update, status: 'finalized' });
  return true;
}

export function clearPendingRequests() {
  _pending.clear();
}

/**
 * Demo reset, used by POST /api/demo/reset.
 *
 *   mode 'seeded' — restore the first-boot baseline: snapshot rules,
 *                   replayed demo traffic, empty pending map.
 *   mode 'empty'  — clear everything so the upload → staging → commit
 *                   pipeline can be demonstrated from a cold start. Sets
 *                   `_emptyLatch` so the lazy seed does not refill until
 *                   the process restarts or a seeded reset runs.
 */
export function resetDemoState(mode = 'seeded') {
  clearLog();
  clearPendingRequests();
  const db = getDb();

  if (mode === 'empty') {
    db.rules = [];
    saveDb(db);
    _emptyLatch = true;
    logTransaction(
      'Operator',
      'DEMO RESET',
      'Demo state cleared to empty. Upload a PA grid PDF or load the pre-ingested snapshot to rebuild the rule index.',
      { seeded: true }
    );
    return { mode, rules: 0 };
  }

  _emptyLatch = false;
  _seeded = false;
  db.rules = [];
  saveDb(db);
  ensureSeeded();
  logTransaction(
    'Operator',
    'DEMO RESET',
    'Demo state restored to the seeded baseline.',
    { seeded: true }
  );
  return { mode, rules: getDb().rules.length };
}

export function logTransaction(actor, action, details, meta = {}) {
  // Seed-before-write: order-sign logs its HOOK RECEIVED entry before its
  // first getDb() call, so without this the first request to a fresh
  // process would mark the log non-empty and silently skip the demo seed.
  ensureSeeded();
  _log.unshift({
    id: Date.now() + Math.floor(Math.random() * 1000),
    timestamp: new Date().toISOString(),
    actor,
    action,
    details,
    ...meta
  });
  if (_log.length > 500) _log.length = 500;
}
