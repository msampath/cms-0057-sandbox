library Aba version '1.0.0'

using FHIR version '4.0.1'

context Patient

// True when an active Condition carries an ICD-10 code in F84.* (pervasive
// developmental disorders) or F80–F89 (specific developmental disorders).
define "HasQualifyingDevelopmentalDiagnosis":
  exists (
    [Condition] C
      where C.clinicalStatus ~ "active"
        and (
          C.code.coding C.coding
            where C.coding.system = 'http://hl7.org/fhir/sid/icd-10-cm'
              and (
                StartsWith(C.coding.code, 'F84')
                or (
                  Substring(C.coding.code, 0, 1) = 'F'
                  and Substring(C.coding.code, 1, 2) between '80' and '89'
                )
              )
        )
  )
