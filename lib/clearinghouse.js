import { IG_REGISTRY, PAS_PROFILES, PRIOR_VERSION_EXPIRY } from './fhir';

/**
 * Intermediary conformance (CMS-0062-P position 5: conformance expectations
 * should reach clearinghouses too, so the standard is not weakened where a
 * transaction is handed off).
 *
 * Checks a PAS request Bundle before it is forwarded to the payer:
 *   - a Bundle of type collection that claims the PAS request Bundle profile
 *   - a versioned profile must name a PAS version the payer accepts: the
 *     sandbox's version, or the version in 45 CFR 170.215 today until the
 *     proposed January 1, 2028 expiry. Anything else is rejected
 *   - a Claim and a Patient are present
 * An unversioned profile passes with a warning.
 *
 * Returns { ok, issues: [{ severity, diagnostics }], version }.
 */
export function checkPasRequestBundle(bundle, { now = new Date() } = {}) {
  const issues = [];
  const error = (d) => issues.push({ severity: 'error', diagnostics: d });
  const warn = (d) => issues.push({ severity: 'warning', diagnostics: d });

  if (bundle?.resourceType !== 'Bundle') error('Body is not a FHIR Bundle.');
  if (bundle?.type !== 'collection') error(`Bundle.type is "${bundle?.type}", PAS requires "collection".`);

  const profiles = Array.isArray(bundle?.meta?.profile) ? bundle.meta.profile : [];
  // Every claim of the PAS profile is checked, so an unversioned claim
  // cannot mask a versioned one with an unaccepted version.
  const claimed = profiles.filter((p) => typeof p === 'string' && p.split('|')[0] === PAS_PROFILES.requestBundle);
  let version = null;
  if (!claimed.length) {
    error('Bundle does not claim the PAS request Bundle profile.');
  } else {
    const pas = IG_REGISTRY.find((g) => g.key === 'pas');
    const priorStillValid = new Date(now) < new Date(`${PRIOR_VERSION_EXPIRY}T00:00:00Z`);
    const accepted = [pas.sandbox, ...(priorStillValid && pas.current ? [pas.current.version] : [])];
    const versions = claimed.filter((p) => p.includes('|')).map((p) => p.split('|')[1]);
    for (const v of versions) {
      if (!accepted.includes(v)) error(`PAS version ${v} is not accepted. Accepted: ${accepted.join(', ')}.`);
    }
    version = versions[0] || null;
    if (!versions.length) warn('PAS profile is unversioned. The payer assumes its current version.');
  }

  if (bundle?.entry !== undefined && !Array.isArray(bundle.entry)) error('Bundle.entry must be an array.');
  const types = (Array.isArray(bundle?.entry) ? bundle.entry : []).map((e) => e?.resource?.resourceType);
  if (!types.includes('Claim')) error('Bundle has no Claim.');
  if (!types.includes('Patient')) error('Bundle has no Patient.');

  return { ok: !issues.some((i) => i.severity === 'error'), issues, version };
}
