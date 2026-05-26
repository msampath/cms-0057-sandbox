library AdvancedImaging version '1.0.0'

using FHIR version '4.0.1'

context Patient

// True when the patient has a completed Procedure for conservative therapy
// (e.g., PT, NSAIDs, bracing) in the prior six months.
define "HasPriorConservativeTherapy":
  exists (
    [Procedure: "Conservative Therapy"] PT
      where PT.status = 'completed'
        and PT.performed starts 6 months or less before Today()
  )
