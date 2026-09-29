/**
 * Da Vinci CDex 2.1.0 solicited attachments for prior authorization
 * (proposed as the HIPAA attachment standard at 45 CFR 162.1302(g)(2)(vii)
 * and for 45 CFR 170.215(k)(3) under CMS-0062-P).
 *
 *   PAS pends → payer sends a CDex attachment-request Task → provider calls
 *   $submit-attachment with the document → payer re-adjudicates.
 *
 * Structure checked against the CDex 2.1.0 Task Attachment Request profile
 * and the $submit-attachment OperationDefinition (hl7.org, 2026-09-29):
 * Task.code is attachment-request-code from PAS's PASTempCodes; the input
 * slices use PASTempCodes (attachments-needed, payer-url) and cdex-temp
 * (service-date, signature-flag, ...). Pure data and functions.
 */

const PAS_TEMP = 'http://hl7.org/fhir/us/davinci-pas/CodeSystem/PASTempCodes';
const CDEX_TEMP = 'http://hl7.org/fhir/us/davinci-cdex/CodeSystem/cdex-temp';
const HREX_TEMP = 'http://hl7.org/fhir/us/davinci-hrex/CodeSystem/hrex-temp';
const LOINC = 'http://loinc.org';
const NPI = 'http://hl7.org/fhir/sid/us-npi';

export const CDEX_PROFILES = {
  attachmentRequestTask: 'http://hl7.org/fhir/us/davinci-cdex/StructureDefinition/cdex-task-attachment-request'
};

// What the payer asks for when a request pends. LOINC 11506-3 is a
// progress note.
export const ATTACHMENT_NEEDED = { system: LOINC, code: '11506-3', display: 'Progress note' };

export const PAYER_ID = { system: 'http://example.org/cdex/payer-ids', value: 'BCBSIL' };

/**
 * The CDex attachment-request Task for a pended PA.
 *   authNumber     the PA's tracking number (PAS preAuthRef)
 *   patient        { id, family, given, memberId }
 *   practitionerNpi
 *   payerUrl       where the provider sends $submit-attachment
 *   dueAt          ISO due date for the attachment
 */
export function buildAttachmentRequestTask({ authNumber, patient, practitionerNpi, payerUrl, dueAt }) {
  return {
    resourceType: 'Task',
    id: `cdex-${String(authNumber).toLowerCase()}`,
    meta: { profile: [CDEX_PROFILES.attachmentRequestTask] },
    contained: [
      {
        resourceType: 'Patient',
        id: 'patient',
        identifier: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MB' }] }, value: patient.memberId }],
        name: [{ family: patient.family, given: patient.given }]
      },
      {
        resourceType: 'PractitionerRole',
        id: 'practitionerrole',
        practitioner: { identifier: { system: NPI, value: practitionerNpi } }
      }
    ],
    identifier: [{ type: { coding: [{ system: HREX_TEMP, code: 'tracking-id' }] }, value: authNumber }],
    status: 'requested',
    intent: 'order',
    code: { coding: [{ system: PAS_TEMP, code: 'attachment-request-code' }] },
    for: { reference: '#patient' },
    authoredOn: new Date().toISOString(),
    requester: { identifier: PAYER_ID },
    owner: { reference: '#practitionerrole' },
    reasonCode: { coding: [{ system: CDEX_TEMP, code: 'preauthorization' }] },
    reasonReference: { identifier: { value: authNumber } },
    restriction: { period: { end: dueAt } },
    input: [
      {
        type: { coding: [{ system: PAS_TEMP, code: 'attachments-needed' }] },
        valueCodeableConcept: { coding: [ATTACHMENT_NEEDED] }
      },
      {
        type: { coding: [{ system: PAS_TEMP, code: 'payer-url' }] },
        valueUrl: payerUrl
      }
    ]
  };
}

/** The $submit-attachment Parameters an EHR sends for that Task. */
export function buildSubmitAttachmentParameters({ authNumber, memberId, practitionerNpi, contentTitle = 'progress-note.txt', contentText = 'Progress note documenting functional impairment.' }) {
  const data = typeof btoa === 'function' ? btoa(contentText) : Buffer.from(contentText).toString('base64');
  return {
    resourceType: 'Parameters',
    parameter: [
      { name: 'TrackingId', valueIdentifier: { value: authNumber } },
      { name: 'AttachTo', valueCode: 'preauthorization' },
      { name: 'PayerId', valueIdentifier: PAYER_ID },
      { name: 'ProviderId', valueIdentifier: { system: NPI, value: practitionerNpi } },
      { name: 'MemberId', valueIdentifier: { value: memberId } },
      {
        name: 'Attachment',
        part: [
          { name: 'LineItem', valueString: '1' },
          { name: 'Code', valueCodeableConcept: { coding: [ATTACHMENT_NEEDED] } },
          {
            name: 'Content',
            resource: {
              resourceType: 'DocumentReference',
              status: 'current',
              type: { coding: [ATTACHMENT_NEEDED] },
              content: [{ attachment: { contentType: 'text/plain', title: contentTitle, data } }]
            }
          }
        ]
      },
      { name: 'Final', valueBoolean: true }
    ]
  };
}

/**
 * Validate a $submit-attachment Parameters body against the operation's
 * cardinalities. Returns { ok, issues, trackingId, attachTo, final, attachments }.
 */
export function validateSubmitAttachment(body) {
  const issues = [];
  if (body?.resourceType !== 'Parameters') issues.push('Body must be a Parameters resource.');
  if (body?.parameter !== undefined && !Array.isArray(body.parameter)) issues.push('Parameters.parameter must be an array.');
  const params = Array.isArray(body?.parameter) ? body.parameter : [];
  const all = (n) => params.filter((p) => p?.name === n);
  const one = (n) => all(n)[0];
  const trackingId = one('TrackingId')?.valueIdentifier?.value;
  const attachTo = one('AttachTo')?.valueCode;
  const memberId = one('MemberId')?.valueIdentifier?.value;
  const providerId = one('ProviderId')?.valueIdentifier?.value || null;
  const attachments = all('Attachment');
  if (all('TrackingId').length !== 1 || !trackingId) issues.push('TrackingId is required (1..1).');
  if (all('AttachTo').length !== 1 || !['claim', 'preauthorization'].includes(attachTo)) {
    issues.push('AttachTo must appear once, as claim or preauthorization (1..1).');
  }
  const finalP = params.find((p) => p?.name === 'Final');
  if (finalP && typeof finalP.valueBoolean !== 'boolean') issues.push('Final must be a valueBoolean.');
  for (const name of ['PayerId', 'OrganizationId', 'ProviderId', 'ServiceDate', 'Final']) {
    if (all(name).length > 1) issues.push(`${name} may appear at most once (0..1).`);
  }
  if (all('MemberId').length !== 1 || !memberId) issues.push('MemberId is required (1..1).');
  if (!one('ProviderId') && !one('OrganizationId')) issues.push('ProviderId or OrganizationId is required.');
  if (!attachments.length) issues.push('At least one Attachment is required (1..*).');
  const partsOf = (a) => (Array.isArray(a?.part) ? a.part : []);
  attachments.forEach((a, i) => {
    const contents = partsOf(a).filter((p) => p?.name === 'Content');
    if (contents.length !== 1 || !contents[0].resource?.resourceType) {
      issues.push(`Attachment ${i + 1} needs exactly one Content resource (1..1).`);
    }
    if (partsOf(a).filter((p) => p?.name === 'Code').length > 1) {
      issues.push(`Attachment ${i + 1} may have at most one Code (0..1).`);
    }
  });
  const finalParam = one('Final');
  return {
    ok: issues.length === 0,
    issues,
    trackingId,
    attachTo,
    memberId,
    providerId,
    // Final defaults to true when absent.
    final: finalParam ? finalParam.valueBoolean !== false : true,
    attachments: attachments.map((a) => ({
      code: partsOf(a).find((p) => p?.name === 'Code')?.valueCodeableConcept?.coding?.[0]?.code || null,
      contentType: partsOf(a).find((p) => p?.name === 'Content')?.resource?.resourceType || null
    }))
  };
}
