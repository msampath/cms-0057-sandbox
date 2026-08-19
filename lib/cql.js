/**
 * CQL evaluator -- runs precompiled ELM JSON against a FHIR R4 Bundle.
 *
 * This is the DTR pre-population pattern: pull FHIR resources from an
 * EHR (Epic via lib/epicBackend.js in our case), then execute a CQL
 * library locally to fill in questionnaire answers. Epic's public
 * sandbox does not expose a server-side CQL evaluation endpoint, so
 * everything happens in-process here.
 *
 * cql-execution v3 runs ELM JSON, not CQL text -- there is no pure-JS
 * CQL-to-ELM translator. ELM must be precompiled offline (Java CLI or
 * the cqframework translation service) and committed to
 * data/cql/elm/*.elm.json. The corresponding .cql source lives beside
 * data/cql/*.cql for documentation and regeneration.
 *
 * Server-only module. Do not import from client components.
 */

import cql from 'cql-execution';
import cqlfhir from 'cql-exec-fhir';

// Registered ELM libraries. Add new entries as CQL libraries are
// precompiled -- keep the key = libraryId contract so the /api/dtr/
// prepopulate route can dispatch by name.
import mriBrainElm from '@/data/cql/elm/MRIBrainPrepopulation.elm.json';

const REGISTRY = {
  MRIBrainPrepopulation: mriBrainElm
};

export function listCqlLibraries() {
  return Object.keys(REGISTRY);
}

// cql-exec-fhir wraps FHIR primitives as FHIRObject class instances
// with multiple enumerable getters (`value`, `id`, `extension`, ...) --
// only `value` is meaningful for our defines, but its presence is what
// signals a wrapped primitive. Peel to `.value` repeatedly, then
// format cql.DateTime-shaped { year, month, day } objects to YYYY-MM-DD
// so the client-side prefill logic can compare against plain
// strings/booleans/dates without threading a wrapper type through the
// questionnaire renderer.
function looksLikeWrapper(node) {
  if (node == null || typeof node !== 'object' || Array.isArray(node)) return false;
  if (!('value' in node)) return false;
  const v = node.value;
  // A wrapper is anything whose .value is a primitive, or another
  // wrapper, or a Date-shaped object. Plain FHIR objects (e.g. an
  // Identifier with a value string) also match -- but for our tiny
  // define set we only ever return primitives or the DateTime shape,
  // so this is safe.
  if (v == null) return false;
  if (typeof v !== 'object') return true;
  if (Array.isArray(v)) return false;
  if (typeof v.year === 'number' && typeof v.month === 'number' && typeof v.day === 'number') return true;
  return 'value' in v;
}

function unwrap(node) {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(unwrap);

  let cur = node;
  while (looksLikeWrapper(cur)) cur = cur.value;

  if (cur != null && typeof cur === 'object' && !Array.isArray(cur)) {
    if (typeof cur.year === 'number' && typeof cur.month === 'number' && typeof cur.day === 'number') {
      const pad = (n) => String(n).padStart(2, '0');
      return `${cur.year}-${pad(cur.month)}-${pad(cur.day)}`;
    }
    const out = {};
    for (const [k, v] of Object.entries(cur)) out[k] = unwrap(v);
    return out;
  }
  if (Array.isArray(cur)) return cur.map(unwrap);
  return cur;
}

/**
 * Evaluate a CQL library against one patient's FHIR R4 Bundle.
 * @param {string} libraryId  registered library id (e.g. 'MRIBrainPrepopulation')
 * @param {object} bundle     FHIR searchset Bundle with Patient + associated resources
 * @returns {{ libraryId, patientId, results }}
 *
 * results maps CQL define names to unwrapped values (strings, booleans,
 * ISO dates, or plain objects). Resource-type counts intentionally not
 * reported here -- cql-exec-fhir's FHIRObject records do not expose
 * resourceType, and the caller already has bundleSummary from the raw
 * bundle it just fetched.
 */
export async function evaluateCqlLibrary(libraryId, bundle) {
  const elm = REGISTRY[libraryId];
  if (!elm) {
    const err = new Error(`Unknown CQL library: ${libraryId}. Known: ${listCqlLibraries().join(', ')}`);
    err.status = 404;
    throw err;
  }

  const lib = new cql.Library(elm);
  const executor = new cql.Executor(lib);
  const psource = cqlfhir.PatientSource.FHIRv401();
  psource.loadBundles([bundle]);

  const raw = await executor.exec(psource);
  const [patientId] = Object.keys(raw.patientResults || {});
  const patientResults = raw.patientResults?.[patientId] || {};

  const results = {};
  for (const [k, v] of Object.entries(patientResults)) {
    if (k === 'Patient') continue; // internal reference to the patient itself
    results[k] = unwrap(v);
  }

  return { libraryId, patientId, results };
}
