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

// UM service-type lookup table
// Imaging (CPT 7xxxx) → '3' Consultation
// J-codes (drug/biologic infusion) → '73' Diagnostic Medical
// BH category rules → 'MH' Mental Health
// Anything else → 'AR' Surgical (default)
function pickServiceTypeCode(rule, orderedCode) {
  if (!rule) return 'AR';
  if (rule.match_type === 'category') return 'MH';
  if (!orderedCode) return 'AR';
  if (orderedCode.startsWith('J')) return '73';
  if (orderedCode.charAt(0) === '7') return '3';
  return 'AR';
}

function pickEntry(bundle, resourceType) {
  if (!bundle?.entry) return null;
  const hit = bundle.entry.find((e) => e?.resource?.resourceType === resourceType);
  return hit ? hit.resource : null;
}

function patientName(p) {
  if (!p?.name?.[0]) return { family: 'DOE', given: 'JANE' };
  return {
    family: (p.name[0].family || 'UNKNOWN').toUpperCase(),
    given: (p.name[0].given?.[0] || '').toUpperCase()
  };
}

function memberId(coverage, patient) {
  return (
    coverage?.subscriberId ||
    coverage?.identifier?.[0]?.value ||
    patient?.id ||
    'UNKNOWN'
  );
}

function primaryIcd10(patient) {
  const cond = patient?.condition?.[0];
  if (!cond) return null;
  return cond?.code?.coding?.[0]?.code || cond?.code?.text || null;
}

function servicedDate(claim) {
  const d = claim?.servicedDate || new Date().toISOString().slice(0, 10);
  return d.replace(/-/g, '');
}

function npi(practitioner) {
  return (
    practitioner?.identifier?.find((i) => /npi/i.test(i.system || ''))?.value ||
    practitioner?.identifier?.[0]?.value ||
    '1234567890'
  );
}

export function getReceiverId(vendor) {
  return VENDOR_TO_ISA[vendor] || VENDOR_TO_ISA.BCBSIL;
}

/**
 * Build X12 278 from the Bundle. Returns:
 *   { x12: <string>, mappings: [{ segment, fhirPath, label, value }, ...] }
 */
export function generateX12_278({ bundle, rule, vendor, orderedCode, isProduction = false }) {
  const patient = pickEntry(bundle, 'Patient');
  const coverage = pickEntry(bundle, 'Coverage');
  const practitioner = pickEntry(bundle, 'Practitioner');
  const claim = pickEntry(bundle, 'Claim');

  const { family, given } = patientName(patient);
  const member = memberId(coverage, patient);
  const npiVal = npi(practitioner);
  const dx = primaryIcd10(patient);
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
    `NM1*X3*2*${vendor.toUpperCase()}*****PI*${receiverId}`,
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

  push(`HL*4*3*EV*0`, '(protocol)', 'HL — Loop 2000E: Service', '');
  push(`TRN*1*${trn}*${senderId}`, '(generated) transaction trace', 'TRN — Trace number', trn);
  push(
    `UM*${serviceTypeCode}*I*${rule?.match_type === 'category' ? 'MH' : '2'}`,
    `(derived) rule.match_type / ordered code shape`,
    'UM — Service type qualifier',
    serviceTypeCode
  );

  if (dx) {
    push(
      `HI*BK:${dx}*ABK:${orderedCode || ''}`,
      `Bundle.entry[?Patient].condition[0].code + Bundle.entry[?Claim].item[0].productOrService.coding[0].code`,
      'HI — Health information (diagnosis + procedure)',
      `BK:${dx} · ABK:${orderedCode}`
    );
  } else {
    push(
      `HI*ABK:${orderedCode || ''}`,
      `Bundle.entry[?Claim].item[0].productOrService.coding[0].code`,
      'HI — Health information (procedure)',
      `ABK:${orderedCode}`
    );
  }

  push(
    `DTP*472*D8*${dos}`,
    `Bundle.entry[?Claim].servicedDate`,
    'DTP — Service date',
    dos
  );

  // Trailer: SE03 = segment count from ST through SE inclusive.
  const stIdx = segs.findIndex((s) => s.startsWith('ST*'));
  const seCount = segs.length - stIdx + 1;
  push(`SE*${seCount}*0001`, '(protocol)', 'SE — Transaction set trailer', String(seCount));
  push(`GE*1*1`, '(protocol)', 'GE — Functional group trailer', '');
  push(`IEA*1*${controlNum}`, '(protocol)', 'IEA — Interchange trailer', controlNum);

  const x12 = segs.join('~\n') + '~';
  return { x12, mappings: maps, trn, controlNum };
}

export function generateX12_278_Response({ receiverId, authNumber }) {
  const yyMMdd = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  const ccyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return (
    [
      `ISA*00*          *00*          *ZZ*${receiverId.padEnd(15)}*ZZ*PROVIDER001    *${yyMMdd}*1200*^*00501*000000002*0*T*:`,
      `GS*HI*${receiverId}*PROVIDER001*${ccyymmdd}*1200*2*X*005010X217`,
      `ST*278*0001*005010X217`,
      `BHT*0007*11*RESP-${Date.now().toString().slice(-8)}*${ccyymmdd}*1200*18`,
      `HL*1**20*1`,
      `AAA*Y*0*A1*N`,
      `HCR*A1*${authNumber}`,
      `REF*BB*${authNumber}`,
      `SE*8*0001`,
      `GE*1*2`,
      `IEA*1*000000002`
    ].join('~\n') + '~'
  );
}
