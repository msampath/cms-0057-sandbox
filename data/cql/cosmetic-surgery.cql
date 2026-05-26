library CosmeticSurgery version '1.0.0'

using FHIR version '4.0.1'

context Patient

// True when a Condition or Observation in the chart documents
// functional impairment relevant to the cosmetic surgery request.
define "FunctionalImpairmentPresent":
  exists (
    [Condition] C
      where C.clinicalStatus ~ "active"
        and C.category ~ "functional-impairment"
  )
  or exists (
    [Observation] O
      where O.status = 'final'
        and O.code ~ "functional-impairment-assessment"
  )
