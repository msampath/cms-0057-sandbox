// Check for the hand-authored MRI Brain ELM library. Not shipped, not part
// of lint or build. Runs the library against synthetic bundles and exits 1
// when a result is wrong, so it can gate a change to the ELM.
//
//   node scripts/testElm.mjs
import { readFileSync } from 'node:fs';
import cql from 'cql-execution';
import cqlfhir from 'cql-exec-fhir';

const elm = JSON.parse(readFileSync('./data/cql/elm/MRIBrainPrepopulation.elm.json', 'utf-8'));

const ICD10 = 'http://hl7.org/fhir/sid/icd-10-cm';
const cond = (status, system, code) => ({
  resourceType: 'Condition',
  id: `c-${code}-${status}`,
  clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: status }] },
  code: { coding: [{ system, code }] },
  subject: { reference: 'Patient/test-1' }
});

// [name, conditions, expected HasRelevantNeuroCondition]
const CASES = [
  ['active G43.909 (migraine)', [cond('active', ICD10, 'G43.909')], true],
  ['active R51.9 (headache)', [cond('active', ICD10, 'R51.9')], true],
  ['active I10 only (hypertension)', [cond('active', ICD10, 'I10')], false],
  ['resolved G43.909', [cond('resolved', ICD10, 'G43.909')], false],
  ['G code in another code system', [cond('active', 'http://snomed.info/sct', 'G123')], false],
  ['no conditions', [], false],
  // Status and code must hold on the same Condition, and system and code on
  // the same coding.
  ['resolved G43.909 plus active I10', [cond('resolved', ICD10, 'G43.909'), cond('active', ICD10, 'I10')], false],
  ['one Condition coded I10 (ICD-10) and G123 (SNOMED)', [{ ...cond('active', ICD10, 'I10'), code: { coding: [{ system: ICD10, code: 'I10' }, { system: 'http://snomed.info/sct', code: 'G123' }] } }], false]
];

let failures = 0;
for (const [name, conditions, expected] of CASES) {
  const psource = cqlfhir.PatientSource.FHIRv401();
  psource.loadBundles([{
    resourceType: 'Bundle',
    type: 'searchset',
    entry: [
      { resource: { resourceType: 'Patient', id: 'test-1', name: [{ family: 'Lopez', given: ['Camila'] }], gender: 'female', birthDate: '1987-09-12' } },
      ...conditions.map((resource) => ({ resource }))
    ]
  }]);
  const result = await new cql.Executor(new cql.Library(elm)).exec(psource);
  const got = result.patientResults['test-1'].HasRelevantNeuroCondition;
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}: ${got}`);
}
console.log(`\n${CASES.length - failures} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
