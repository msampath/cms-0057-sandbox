import { NextResponse } from 'next/server';
import { getDb, logTransaction } from '@/lib/db';
import {
  generateX12_278,
  generateX12_278_Response,
  getReceiverId
} from '../x12Generator';

/**
 * PAS submit endpoint.
 *
 * Accepts a FHIR `Bundle` (type=transaction). The Bundle is preserved
 * unaltered (Da Vinci PAS "unaltered FHIR Bundle" strategy) and a
 * parallel X12 278 projection is generated for the legacy adjudication
 * engine. Both are emitted to the UM live feed together so the field-to-
 * segment mapping is inspectable in real time.
 *
 * On the response side: a mock X12 278 Response is synthesized, the FHIR
 * `ClaimResponse` is built directly from the original Bundle + the auth
 * number (no FHIR→X12→FHIR round-trip), and a `coverage-information`
 * system action with `pa-needed: "satisfied"` is returned.
 */

function pickEntry(bundle, type) {
  if (!bundle?.entry) return null;
  const hit = bundle.entry.find((e) => e?.resource?.resourceType === type);
  return hit ? hit.resource : null;
}

function primaryIcd10(patient) {
  const cond = patient?.condition?.[0];
  if (!cond) return null;
  return cond?.code?.coding?.[0]?.code || cond?.code?.text || null;
}

function resolveVendor(rule, patient) {
  if (!rule) return 'BCBSIL';
  if (rule.managed_by !== 'Carelon-or-BCBSIL-conditional') return rule.managed_by;
  const dx = primaryIcd10(patient);
  if (!dx) return 'BCBSIL';
  const first = dx.charAt(0).toUpperCase();
  const tens = parseInt(dx.substring(1, 3), 10);
  return first === 'C' || (first === 'D' && tens <= 49) ? 'Carelon' : 'BCBSIL';
}

function findRule(rules, orderedCode, serviceCategory) {
  if (orderedCode) {
    const byCode = rules.find(
      (r) => r.match_type === 'code' && r.service_code === orderedCode
    );
    if (byCode) return byCode;
  }
  if (serviceCategory) {
    const needle = serviceCategory.toLowerCase();
    return (
      rules.find(
        (r) =>
          r.match_type === 'category' &&
          r.service_category &&
          (r.service_category.toLowerCase().includes(needle) ||
            needle.includes(r.service_category.toLowerCase()))
      ) || null
    );
  }
  return null;
}

export async function POST(request) {
  const bundle = await request.json();

  const claim = pickEntry(bundle, 'Claim');
  const patient = pickEntry(bundle, 'Patient');
  const orderedCode =
    claim?.item?.[0]?.productOrService?.coding?.[0]?.code ||
    bundle.serviceCode ||
    null;
  const serviceCategory =
    claim?.item?.[0]?.productOrService?.text || bundle.serviceCategory || null;

  logTransaction(
    'PAS Gateway',
    'BUNDLE RECEIVED',
    `FHIR Bundle (type=${bundle.type || '—'}) for Patient/${patient?.id || 'unknown'}, code=${orderedCode || '—'}. Bundle preserved unaltered.`
  );

  const rule = findRule(getDb().rules, orderedCode, serviceCategory);
  const vendor = resolveVendor(rule, patient);

  // Generate the X12 278 alongside the Bundle (parallel projection, not a
  // destructive conversion).
  const { x12, mappings } = generateX12_278({
    bundle,
    rule,
    vendor,
    orderedCode
  });

  // Structured log: the UM Dashboard renders this with the inline FHIR↔X12
  // translation drawer. The bundle is included verbatim (unaltered).
  logTransaction('PAS Gateway', 'X12 278 REQUEST', {
    kind: 'fhir-x12-translation',
    vendor,
    bundle,
    x12,
    mappings,
    note: 'Bundle preserved unaltered; X12 is a parallel projection for the legacy adjudication engine.'
  });

  // Simulate mainframe latency.
  await new Promise((r) => setTimeout(r, 2500));

  const authNumber = `AUTH${Date.now().toString().slice(-7)}`;
  const receiverId = getReceiverId(vendor);
  const x12Response = generateX12_278_Response({ receiverId, authNumber });

  logTransaction(
    'Legacy UM Mainframe',
    'X12 278 RESPONSE',
    `Decision: APPROVED. Auth # ${authNumber}.\n\n${x12Response}`
  );

  // FHIR ClaimResponse is constructed directly from the preserved Bundle
  // + the auth number lifted from the X12 response. No round-trip.
  const claimResponse = {
    resourceType: 'ClaimResponse',
    id: `cr-${Date.now()}`,
    status: 'active',
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'institutional' }] },
    use: 'preauthorization',
    patient: { reference: `Patient/${patient?.id || 'unknown'}` },
    outcome: 'complete',
    disposition: `Prior Authorization Approved by ${vendor}.`,
    preAuthRef: authNumber,
    insurer: { display: vendor }
  };

  const satisfiedAction = {
    type: 'update',
    description: 'Coverage information updated post-PAS adjudication',
    resource: {
      resourceType: 'Task',
      status: 'completed',
      intent: 'proposal',
      code: { coding: [{ system: 'http://hl7.org/fhir/us/davinci-crd/CodeSystem/temp', code: 'coverage-information' }] },
      for: { reference: `Patient/${patient?.id || 'unknown'}` },
      authoredOn: new Date().toISOString(),
      extension: [
        { url: 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information#covered', valueCode: 'covered' },
        { url: 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information#pa-needed', valueCode: 'satisfied' },
        { url: 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information#billingCode', valueCoding: { system: 'http://www.ama-assn.org/go/cpt', code: orderedCode || '' } },
        { url: 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information#date', valueDateTime: new Date().toISOString() },
        { url: 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information#authNumber', valueString: authNumber }
      ]
    }
  };

  logTransaction(
    'PAS Gateway',
    'COVERAGE-INFORMATION ACTION',
    JSON.stringify(satisfiedAction.resource, null, 2)
  );
  logTransaction(
    'PAS Translator',
    'FHIR RESPONSE',
    `ClaimResponse synthesised from preserved Bundle + auth # ${authNumber} (no FHIR→X12→FHIR round-trip).`
  );

  return NextResponse.json({
    ...claimResponse,
    systemActions: [satisfiedAction],
    _routedTo: vendor
  });
}
