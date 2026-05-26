library Blepharoplasty version '1.0.0'

using FHIR version '4.0.1'

context Patient

// True when the patient has an active Condition indicating
// visual-field obstruction or dermatochalasis affecting the eyelid.
define "FunctionalImpairmentPresent":
  exists (
    [Condition] C
      where C.clinicalStatus ~ "active"
        and (
          C.code ~ Code '246636008' from "http://snomed.info/sct"   // visual field obstruction
          or C.code ~ Code '193986002' from "http://snomed.info/sct" // dermatochalasis
        )
  )
