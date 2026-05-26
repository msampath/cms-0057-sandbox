/**
 * Procedural rule synthesizer.
 *
 * The curated rule sets in stagingData.js drive the demo flows (oncology
 * routing, blepharoplasty critical indicator, BH category match, etc.).
 * Real BCBSIL grids carry hundreds of rows. This module pads each pattern
 * with deterministic synthetic rules drawn from realistic CPT/HCPCS/J-code
 * ranges so per-file counts look right (~250 for MA, ~350 for Commercial
 * Med-Surg, ~90 for Specialty Pharmacy, ~25 for BH).
 *
 * Synthetic rules are bound to the fallback Questionnaire — they exist
 * to fill out the index, not to drive specific demo paths.
 */

// Tiny seeded PRNG so the same filename always produces the same rules.
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

const DESCRIPTIONS = {
  Integumentary: 'Skin/lesion procedure',
  Musculoskeletal: 'Musculoskeletal procedure',
  Respiratory: 'Respiratory system procedure',
  Cardiovascular: 'Cardiovascular procedure',
  Digestive: 'Digestive system procedure',
  Urinary: 'Urinary/Genital procedure',
  Nervous: 'Nervous system / Eye procedure',
  Radiology: 'Radiology / advanced imaging',
  Pathology: 'Pathology and laboratory',
  Medicine: 'Medicine / therapeutic',
  EM: 'Evaluation & Management',
  JCode: 'Specialty drug or biologic',
  HCPCS: 'HCPCS Level II item'
};

const BUCKETS = {
  // Commercial Med-Surg distribution: mostly surgical with imaging cluster.
  medsurg: [
    { range: [10000, 19999], label: 'Integumentary', paRate: 0.45, vendor: 'BCBSIL' },
    { range: [20000, 29999], label: 'Musculoskeletal', paRate: 0.60, vendor: 'BCBSIL' },
    { range: [30000, 39999], label: 'Respiratory', paRate: 0.40, vendor: 'BCBSIL' },
    { range: [33000, 37999], label: 'Cardiovascular', paRate: 0.65, vendor: 'BCBSIL' },
    { range: [40000, 49999], label: 'Digestive', paRate: 0.50, vendor: 'BCBSIL' },
    { range: [50000, 59999], label: 'Urinary', paRate: 0.45, vendor: 'BCBSIL' },
    { range: [60000, 69999], label: 'Nervous', paRate: 0.55, vendor: 'BCBSIL' },
    { range: [70000, 79999], label: 'Radiology', paRate: 0.80, vendor: 'Carelon' }
  ],
  // Medicare Advantage: heavy on E&M + imaging + medicine.
  ma: [
    { range: [70000, 79999], label: 'Radiology', paRate: 0.75, vendor: 'Carelon' },
    { range: [20000, 29999], label: 'Musculoskeletal', paRate: 0.55, vendor: 'BCBSIL' },
    { range: [33000, 37999], label: 'Cardiovascular', paRate: 0.70, vendor: 'BCBSIL' },
    { range: [90000, 99000], label: 'Medicine', paRate: 0.30, vendor: 'BCBSIL' },
    { range: [99201, 99499], label: 'EM', paRate: 0.05, vendor: 'BCBSIL' },
    { range: [80000, 89999], label: 'Pathology', paRate: 0.10, vendor: 'BCBSIL' }
  ],
  // Specialty Pharmacy: J-codes only.
  pharm: [
    { range: [0, 9999], label: 'JCode', paRate: 0.92, vendor: 'BCBSIL', prefix: 'J' }
  ],
  // BH: small set of HCPCS codes; the BH grid's main signal is the
  // service-category rules curated in stagingData.js, so synthesis here
  // is intentionally light.
  bh: [
    { range: [90791, 90899], label: 'Medicine', paRate: 0.50, vendor: 'Lucet' },
    { range: [96100, 96199], label: 'Medicine', paRate: 0.70, vendor: 'Lucet' }
  ]
};

function pickRange(buckets, rand) {
  return buckets[rand() % buckets.length];
}

function formatCode(bucket, codeNum) {
  if (bucket.prefix === 'J') return 'J' + String(codeNum).padStart(4, '0');
  return String(codeNum).padStart(5, '0');
}

function synthBucket(seed, count, buckets, sourceFile) {
  const rand = lcg(seed);
  const out = [];
  const seen = new Set();
  let safety = count * 5;
  while (out.length < count && safety-- > 0) {
    const bucket = pickRange(buckets, rand);
    const [lo, hi] = bucket.range;
    const codeNum = lo + (rand() % Math.max(1, hi - lo));
    const code = formatCode(bucket, codeNum);
    if (seen.has(code)) continue;
    seen.add(code);

    const isAuth = (rand() % 100) < Math.round(bucket.paRate * 100);
    const description = `${DESCRIPTIONS[bucket.label] || bucket.label} (${code})`;
    out.push({
      match_type: 'code',
      service_code: code,
      service_category: null,
      description,
      pa_needed: isAuth ? 'auth-needed' : 'no-auth',
      managed_by: bucket.vendor,
      questionnaire_id: isAuth ? 'fallback-medical-necessity' : null,
      cql_library_id: null,
      documentation_requirements: isAuth ? 'Generic medical necessity attestation' : '',
      effective_date: '2026-01-01'
    });
  }
  return out;
}

/**
 * Top-level entry. `kind` is one of 'ma' | 'medsurg' | 'pharm' | 'bh'.
 * The seed is derived from the filename so re-uploading the same file
 * gives the same rules.
 */
export function synthesize(kind, count, sourceFile) {
  const buckets = BUCKETS[kind];
  if (!buckets) return [];
  const seed = hashSeed(`${kind}:${sourceFile}`);
  return synthBucket(seed, count, buckets, sourceFile);
}

// Tunable per-pattern counts. Roughly mirrors the real BCBSIL grids' sizes.
export const SYNTH_COUNTS = {
  ma: 245,
  medsurg: 345,
  pharm: 90,
  bh: 22
};
