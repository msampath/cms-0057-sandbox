/**
 * Da Vinci PAS profile constants and response envelope.
 *
 * Canonical URLs verified against the published PAS IG (v2.2.1, STU 2).
 * profile-pas-response-bundle fixes Bundle.type to `collection` — PAS
 * mirrors the X12 278 request/response model rather than FHIR transaction
 * semantics, so `collection` (not `transaction-response`) is the conformant
 * type for both request and response bundles.
 */

export const PAS_PROFILES = {
  requestBundle:
    'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-pas-request-bundle',
  responseBundle:
    'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-pas-response-bundle',
  claim: 'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-claim',
  claimResponse:
    'http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-claimresponse'
};

/**
 * Wrap PAS response resources (ClaimResponse first, plus the
 * coverage-information Task when one is emitted) in the profile-conformant
 * response Bundle.
 */
export function wrapPasResponseBundle(resources) {
  return {
    resourceType: 'Bundle',
    id: `pas-response-${Date.now()}`,
    meta: { profile: [PAS_PROFILES.responseBundle] },
    type: 'collection',
    timestamp: new Date().toISOString(),
    entry: resources.filter(Boolean).map((resource) => ({
      fullUrl: `urn:uuid:${crypto.randomUUID()}`,
      resource
    }))
  };
}
