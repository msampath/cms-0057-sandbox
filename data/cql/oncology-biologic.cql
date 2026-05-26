library OncologyBiologic version '1.0.0'

using FHIR version '4.0.1'

context Patient

// Return the first active Condition whose ICD-10 code lies in the
// neoplasm block (C00–D49). The selected code drives Phase 2 conditional
// routing between Carelon (oncology-aligned UM) and BCBSIL (default UM).
define "PrimaryOncologyDiagnosis":
  First(
    [Condition] C
      where C.clinicalStatus ~ "active"
        and (
          C.code.coding C.coding
            where C.coding.system = 'http://hl7.org/fhir/sid/icd-10-cm'
              and Substring(C.coding.code, 0, 1) in { 'C', 'D' }
              and (
                Substring(C.coding.code, 0, 1) = 'C'
                or Substring(C.coding.code, 1, 2) <= '49'
              )
        )
      sort by recordedDate desc
  )
