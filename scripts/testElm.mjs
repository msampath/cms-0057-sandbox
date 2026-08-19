// Quick smoke test for the MRI Brain ELM library. Not shipped, not
// part of any lint/build target -- runs against a synthetic Patient +
// Condition bundle to prove hand-authored ELM parses and executes.
//
//   node scripts/testElm.mjs
import { readFileSync } from 'node:fs';
import cql from 'cql-execution';
import cqlfhir from 'cql-exec-fhir';

const elm = JSON.parse(readFileSync('./data/cql/elm/MRIBrainPrepopulation.elm.json', 'utf-8'));

const lib = new cql.Library(elm);
const executor = new cql.Executor(lib);
const psource = cqlfhir.PatientSource.FHIRv401();

const bundle = {
  resourceType: 'Bundle',
  type: 'searchset',
  entry: [
    {
      resource: {
        resourceType: 'Patient',
        id: 'test-1',
        name: [{ use: 'official', family: 'Lopez', given: ['Camila', 'Maria'] }],
        gender: 'female',
        birthDate: '1987-09-12'
      }
    },
    {
      resource: {
        resourceType: 'Condition',
        id: 'cond-1',
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
        code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'G43.909', display: 'Migraine, unspecified' }] },
        subject: { reference: 'Patient/test-1' }
      }
    }
  ]
};

psource.loadBundles([bundle]);
try {
  const result = await executor.exec(psource);
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error('EXEC ERROR:', e.message);
  console.error(e.stack);
  process.exit(1);
}
