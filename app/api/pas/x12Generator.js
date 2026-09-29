import { claimDiagnosisCodes } from '@/lib/routing';

/**
 * FHIR Bundle → X12 278 projection.
 *
 * Unaltered FHIR Bundle strategy (Da Vinci PAS-aligned):
 *   - The Bundle is preserved by the caller as the source of truth.
 *   - This module emits a parallel X12 278 representation for the legacy
 *     adjudication engine, and returns a `mappings` array linking each
 *     segment back to the FHIR path it was projected from.
 *   - No round-trip loss: the Bundle never has to be reconstructed from
 *     X12 because the original is retained alongside.
 *
 * Honest framing: this 278 is illustrative. Production payloads carry
 * ~30 segments with full envelope, trading-partner agreements, and TR3
 * 005010X217 conformance. This is screen-fitting for demo visibility.
 */

const VENDOR_TO_ISA = {
  BCBSIL: 'BCBSIL00001',
  Carelon: 'CARELON0001',
  Lucet: 'LUCET000001',
  EviCore: 'EVICORE0001'
};

// UM03 service type (X12 element 1365):
//   BH category rules            → MH  Mental Health
//   J-codes (clinic-administered) → 1   Medical Care
//   CT/MRI imaging (by rule text) → 62  MRI/CAT Scan
//   other 7xxxx radiology         → 4   Diagnostic X-Ray
//   10000-69999 surgery           → 2   Surgical
//   anything else                 → 1   Medical Care
function pickServiceTypeCode(rule, orderedCode) {
  if (rule?.match_type === 'category') return 'MH';
  const code = String(orderedCode || '');
  if (/^J\d{4}$/.test(code)) return '1';
  if (/^7\d{4}$/.test(code)) return /\b(MRI|CT|CAT|magnetic|tomograph)/i.test(rule?.description || '') ? '62' : '4';
  if (/^\d{5}$/.test(code) && Number(code) >= 10000 && Number(code) <= 69999) return '2';
  return '1';
}

// Bundle values go into X12 elements, so the 278 delimiters (~ * : ^) and
// line breaks are replaced, and non-strings are coerced first.
export function x12Safe(v) {
  return String(v ?? '').replace(/[~*:^\r\n]/g, ' ');
}

function pickEntry(bundle, resourceType) {
  if (!Array.isArray(bundle?.entry)) return null;
  const hit = bundle.entry.find((e) => e?.resource?.resourceType === resourceType);
  return hit ? hit.resource : null;
}

function patientName(p) {
  if (!p?.name?.[0]) return { family: 'DOE', given: 'JANE' };
  return {
    family: x12Safe(p.name[0].family || 'UNKNOWN').toUpperCase(),
    given: x12Safe(p.name[0].given?.[0] || '').toUpperCase()
  };
}

function memberId(coverage, patient) {
  return x12Safe(
    coverage?.subscriberId ||
    coverage?.identifier?.[0]?.value ||
    patient?.id ||
    'UNKNOWN'
  );
}

// Principal diagnosis from Claim.diagnosis (R4 Patient has no condition).
function primaryIcd10(claim) {
  const v = claimDiagnosisCodes(claim)[0] || null;
  return v ? x12Safe(v).replace(/\./g, '') : null;
}

function servicedDate(claim) {
  const item = Array.isArray(claim?.item) ? claim.item[0] : null;
  const v = typeof item?.servicedDate === 'string' ? item.servicedDate.slice(0, 10) : '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : new Date().toISOString().slice(0, 10);
  return d.replace(/-/g, '');
}

function npi(practitioner) {
  const ids = Array.isArray(practitioner?.identifier) ? practitioner.identifier : [];
  return x12Safe(
    ids.find((i) => /npi/i.test(String(i?.system || '')))?.value ||
    ids[0]?.value ||
    '1234567890'
  );
}

export function getReceiverId(vendor) {
  return typeof vendor === 'string' && Object.hasOwn(VENDOR_TO_ISA, vendor) ? VENDOR_TO_ISA[vendor] : VENDOR_TO_ISA.BCBSIL;
}

/**
 * Build X12 278 from the Bundle. Returns:
 *   { x12: <string>, mappings: [{ segment, fhirPath, label, value }, ...] }
 */
export function generateX12_278({ bundle, rule, vendor, orderedCode: rawCode, isProduction = false }) {
  const orderedCode = rawCode == null ? rawCode : x12Safe(rawCode);
  const patient = pickEntry(bundle, 'Patient');
  const coverage = pickEntry(bundle, 'Coverage');
  const practitioner = pickEntry(bundle, 'Practitioner');
  const claim = pickEntry(bundle, 'Claim');

  const { family, given } = patientName(patient);
  const member = memberId(coverage, patient);
  const npiVal = npi(practitioner);
  const dx = primaryIcd10(claim);
  const dos = servicedDate(claim);
  const serviceTypeCode = pickServiceTypeCode(rule, orderedCode);

  const receiverId = getReceiverId(vendor);
  const senderId = 'PROVIDER001';
  const now = new Date();
  const yyMMdd =
    String(now.getFullYear()).slice(2) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
  const hhmm =
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0');
  const ccyymmdd = String(now.getFullYear()) + yyMMdd.slice(2);
  const controlNum = String(now.getTime()).slice(-9).padStart(9, '0');
  const usage = isProduction ? 'P' : 'T';
  const trn = `TRN-${String(now.getTime()).slice(-8)}`;

  // segments[i] is paired with mappings[i] (when a mapping exists).
  const segs = [];
  const maps = [];

  const push = (segment, fhirPath, label, value) => {
    segs.push(segment);
    maps.push({ segment, fhirPath, label, value });
  };

  push(
    `ISA*00*          *00*          *ZZ*${senderId.padEnd(15)}*ZZ*${receiverId.padEnd(15)}*${yyMMdd}*${hhmm}*^*00501*${controlNum}*0*${usage}*:`,
    `(derived) routing.vendor → "${vendor}"`,
    'ISA — Interchange envelope',
    receiverId
  );
  push(
    `GS*HI*${senderId}*${receiverId}*${ccyymmdd}*${hhmm}*1*X*005010X217`,
    `(derived) routing.vendor → "${vendor}"`,
    'GS — Functional group',
    receiverId
  );
  push(`ST*278*0001*005010X217`, '(protocol)', 'ST — Transaction set header', '278');
  push(
    `BHT*0007*13*${trn}*${ccyymmdd}*${hhmm}*18`,
    '(generated) transaction trace number',
    'BHT — Beginning of hierarchical transaction',
    trn
  );

  push(`HL*1**20*1`, '(protocol)', 'HL — Loop 2000A: UMO (payer)', '');
  push(
    `NM1*X3*2*${x12Safe(vendor || 'BCBSIL').toUpperCase()}*****PI*${receiverId}`,
    `routing.vendor`,
    'NM1 — Payer / UM organisation name',
    vendor
  );

  push(`HL*2*1*21*1`, '(protocol)', 'HL — Loop 2000B: Requester', '');
  push(
    `NM1*1P*2*REQUESTING PROVIDER*****XX*${npiVal}`,
    `Bundle.entry[?Practitioner].identifier[NPI].value`,
    'NM1 — Requester (Practitioner NPI)',
    npiVal
  );

  push(`HL*3*2*22*1`, '(protocol)', 'HL — Loop 2000C: Subscriber / Patient', '');
  push(
    `NM1*IL*1*${family}*${given}****MI*${member}`,
    `Bundle.entry[?Patient].name[0] + Bundle.entry[?Coverage].subscriberId`,
    'NM1 — Subscriber (Patient name + member ID)',
    `${family}, ${given} · ${member}`
  );

  push(`HL*4*3*EV*${orderedCode ? 1 : 0}`, '(protocol)', 'HL — Loop 2000E: Patient event', '');
  push(`TRN*1*${trn}*${senderId}`, '(generated) transaction trace', 'TRN — Trace number', trn);
  push(
    `UM*HS*I*${serviceTypeCode}`,
    `(derived) rule.match_type / ordered code shape`,
    'UM — Health services review, initial request, service type (UM03)',
    serviceTypeCode
  );

  if (dx) {
    push(
      `HI*ABK:${dx}`,
      `Bundle.entry[?Claim].diagnosis[0].diagnosisCodeableConcept`,
      'HI — Principal diagnosis (ICD-10-CM, ABK)',
      `ABK:${dx}`
    );
  }

  if (orderedCode) {
    // Loop 2000F: the requested service. UM, the service date, then SV1
    // with the procedure code (HC covers CPT and HCPCS).
    push(`HL*5*4*SS*0`, '(protocol)', 'HL — Loop 2000F: Service', '');
    push(`UM*HS*I*${serviceTypeCode}`, `(derived) ordered code`, 'UM — Service-level review request', serviceTypeCode);
    push(
      `DTP*472*D8*${dos}`,
      `Bundle.entry[?Claim].item[0].servicedDate`,
      'DTP — Service date',
      dos
    );
    push(
      `SV1*HC:${orderedCode}**UN*1`,
      `Bundle.entry[?Claim].item[0].productOrService.coding[0].code`,
      'SV1 — Professional service (procedure code)',
      `HC:${orderedCode}`
    );
  } else {
    push(
      `DTP*AAH*D8*${dos}`,
      `Bundle.entry[?Claim].item[0].servicedDate`,
      'DTP — Event date (no service line)',
      dos
    );
  }

  // Trailer: SE03 = segment count from ST through SE inclusive.
  const stIdx = segs.findIndex((s) => s.startsWith('ST*'));
  const seCount = segs.length - stIdx + 1;
  push(`SE*${seCount}*0001`, '(protocol)', 'SE — Transaction set trailer', String(seCount));
  push(`GE*1*1`, '(protocol)', 'GE — Functional group trailer', '');
  push(`IEA*1*${controlNum}`, '(protocol)', 'IEA — Interchange trailer', controlNum);

  const x12 = segs.join('~\n') + '~';
  return { x12, mappings: maps, trn, controlNum };
}

/**
 * X12 278 response for a clinical determination. The decision rides in HCR
 * (HCR01 action code from Code Source 306, HCR03 reason code from External
 * Code Source 886). AAA is for request validation errors, so it does not
 * appear on a decision.
 *   A1 certified     → HCR*A1*<cert #> + REF*BB
 *   A3 not certified → HCR*A3**<886 reason>
 *   A4 pended        → HCR*A4
 * A request that fails validation gets no decision. It returns AAA with a
 * reject reason (Code Source 901) and follow-up action C (correct and
 * resubmit) instead of HCR:
 *   AAA              → AAA*N**<901 reason>*C
 */
const RESPONSE_CONTROL = { A1: 2, A3: 3, A4: 4, AAA: 5 };

export function generateX12_278_Response({ receiverId, authNumber, action = 'A1', reasonCode = '' }) {
  const yyMMdd = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const ccyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const control = RESPONSE_CONTROL[action] || 2;
  const isaControl = String(control).padStart(9, '0');

  const decision =
    action === 'A1'
      ? [`HCR*A1*${authNumber}`, `REF*BB*${authNumber}`]
      : action === 'A3'
        ? [`HCR*A3**${reasonCode}`]
        : action === 'AAA'
          ? [`AAA*N**${reasonCode}*C`]
          : [`HCR*${action}`];

  const txn = [
    `ST*278*0001*005010X217`,
    `BHT*0007*11*RESP-${Date.now().toString().slice(-8)}*${ccyymmdd}*1200*18`,
    `HL*1**20*1`,
    ...decision
  ];
  // SE01 counts every segment from ST through SE inclusive.
  txn.push(`SE*${txn.length + 1}*0001`);

  return (
    [
      `ISA*00*          *00*          *ZZ*${receiverId.padEnd(15)}*ZZ*PROVIDER001    *${yyMMdd}*1200*^*00501*${isaControl}*0*T*:`,
      `GS*HI*${receiverId}*PROVIDER001*${ccyymmdd}*1200*${control}*X*005010X217`,
      ...txn,
      `GE*1*${control}`,
      `IEA*1*${isaControl}`
    ].join('~\n') + '~'
  );
}
