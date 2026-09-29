/*
 * MRI Brain (CPT 70553) DTR pre-population library.
 *
 * Consumed by lib/cql.js at runtime -- ELM compilation lives in
 * data/cql/elm/MRIBrainPrepopulation.elm.json. Regenerate ELM with the
 * CQL-to-ELM translator when this file changes:
 *   curl -X POST https://cql-translation-service.dev.cqframework.org/cql/translator \
 *        -H "Content-Type: application/cql" -H "Accept: application/elm+json" \
 *        --data-binary @data/cql/MRIBrainPrepopulation.cql > data/cql/elm/MRIBrainPrepopulation.elm.json
 * Translator output includes FHIRHelpers, so lib/cql.js must pass a
 * library repository holding the FHIRHelpers ELM to cql.Library, not only
 * add a REGISTRY entry. Run node scripts/testElm.mjs after regenerating.
 *
 * The demographic defines feed the questionnaire's identity items.
 * HasRelevantNeuroCondition is an example clinical define -- true if
 * the patient has an active Condition with an ICD-10-CM code in a range
 * that would justify the imaging order (G or R), showing the
 * pre-population pattern end to end.
 */
library MRIBrainPrepopulation version '1.0.0'

using FHIR version '4.0.1'

context Patient

define "PatientGivenName":
  First(Patient.name).given[0]

define "PatientFamilyName":
  First(Patient.name).family

define "PatientDOB":
  Patient.birthDate

define "PatientGender":
  Patient.gender

// A minimal clinical pre-population example: true if the patient has
// any active Condition with an ICD-10 code in ranges commonly cited
// for MRI Brain (G-series neurological, R-series symptoms).
define "HasRelevantNeuroCondition":
  exists (
    [Condition] C
      where exists (C.clinicalStatus.coding S where S.code = 'active')
        and exists (
          C.code.coding CD
            where CD.system = 'http://hl7.org/fhir/sid/icd-10-cm'
              and (StartsWith(CD.code, 'G') or StartsWith(CD.code, 'R'))
        )
  )
