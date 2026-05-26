library Rtms version '1.0.0'

using FHIR version '4.0.1'

context Patient

// True when at least two distinct MedicationStatement resources document
// completed or stopped antidepressant trials (SSRI / SNRI / TCA classes).
// Real implementations would resolve RxNorm class membership through a
// value set; this define names that intent.
define "HasPriorAntidepressantTrials":
  Count(
    distinct (
      [MedicationStatement] MS
        where MS.status in { 'completed', 'stopped' }
          and (
            MS.medication in "Antidepressant SSRI Class"
            or MS.medication in "Antidepressant SNRI Class"
            or MS.medication in "Antidepressant TCA Class"
          )
        return MS.medication
    )
  ) >= 2
