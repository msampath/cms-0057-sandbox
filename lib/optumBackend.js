/**
 * Optum Real Prior Authorization & Provider Access API client.
 *
 * A third outbound integration alongside lib/epicBackend.js (EHR-side
 * SMART Backend Services) and lib/availity.js (clearinghouse). This one
 * is the most direct analog to this sandbox's own payer engine: it calls
 * a real, independently-built implementation of the same CMS-0057-F
 * APIs -- Da Vinci CRD/DTR/PAS for prior authorization, and Da Vinci PDex
 * multi-member-match for provider access -- run by Optum/UnitedHealthcare.
 *
 * Four operations, all verified against Optum's live sandbox before this
 * module was written (not guessed from docs, which had two real errors:
 * the token endpoint wants form-encoded data despite the setup guide
 * showing a JSON body, and the CDS Hooks service id in the discovery
 * response, "coverageRequirements-serviceRequest", is NOT the id the
 * invocation route expects -- that's "crd-order-sign", found only in a
 * working Try-It example):
 *
 *   1. crd-order-sign        CDS Hooks 2.0 order-sign card -- a second,
 *                            independent CRD opinion on the same order
 *                            our own engine and Availity evaluate
 *   2. questionnaire-package Da Vinci DTR questionnaire retrieval
 *   3. Claim/$submit         Da Vinci PAS submission
 *   4. $bulk-member-match    Da Vinci PDex provider-access member match
 *
 * Same four-mode gating shape as the other two outbound clients
 * (disabled | mock-forced | mock-no-credentials | live). Mock responses
 * are trimmed real captures from Optum's own sandbox, not invented data,
 * so mock mode looks like what live mode actually returns.
 *
 * Env:
 *   OPTUM_CLIENT_ID       sandbox client id
 *   OPTUM_CLIENT_SECRET   sandbox client secret
 *   OPTUM_ENABLED=off     kill switch (overrides everything -> 501)
 *   OPTUM_MOCK=on         force mock even when credentials are present
 */

import crypto from 'crypto';

const TOKEN_ENDPOINT = 'https://sandbox-apigw.optum.com/apip/auth/sntl/v1/token';
const PRIOR_AUTH_BASE = 'https://sandbox-apigw.optum.com/oihub/fhirpriorauth/v1';
const PROVIDER_ACCESS_BASE = 'https://sandbox-apigw.optum.com/oihub/fhirprovideraccess/v1';

// Confirmed working sandbox payer/line-of-business pair. Prior Auth uses
// 'ph' (Physical Health); Provider Access's working example used 'bh'
// (Behavioral Health) -- same payer, different LOB per API, both real
// values pulled from Optum's own Try-It console, not guessed.
const PAYER_ID = '87726';
const PRIOR_AUTH_LOB = 'ph';
const PROVIDER_ACCESS_LOB = 'bh';

let cachedToken = null;

export function optumEnabled() {
  return process.env.OPTUM_ENABLED !== 'off';
}

function haveCredentials() {
  return Boolean(process.env.OPTUM_CLIENT_ID && process.env.OPTUM_CLIENT_SECRET);
}

export function optumMode() {
  if (!optumEnabled()) return 'disabled';
  if (process.env.OPTUM_MOCK === 'on') return 'mock-forced';
  if (!haveCredentials()) return 'mock-no-credentials';
  return 'live';
}

function correlationId() {
  return crypto.randomUUID();
}

async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 10000) {
    return cachedToken.accessToken;
  }
  // Form-encoded, NOT the JSON body Optum's own API Setup guide shows --
  // the live endpoint rejects JSON with "Missing form parameter: grant_type".
  const body = new URLSearchParams({
    client_id: process.env.OPTUM_CLIENT_ID,
    client_secret: process.env.OPTUM_CLIENT_SECRET,
    grant_type: 'client_credentials'
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Optum token error: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000
  };
  return cachedToken.accessToken;
}

async function optumFetch(url, { method = 'GET', body } = {}) {
  const token = await getToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'environment': 'sandbox', // demo/mock response mode, per Optum's docs
    'x-optum-consumer-correlation-id': correlationId()
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _rawText: text };
  }
  if (!res.ok) {
    const err = new Error(`Optum API error: ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// ---- 1. CDS Hooks order-sign -----------------------------------------

function buildOrderSignHook({ patientId, practitionerId, code, display }) {
  return {
    hookInstance: crypto.randomUUID(),
    hook: 'order-sign',
    context: {
      userId: `Practitioner/${practitionerId}`,
      patientId,
      draftOrders: {
        resourceType: 'Bundle',
        type: 'collection',
        entry: [
          {
            resource: {
              resourceType: 'ServiceRequest',
              id: 'order-1',
              status: 'draft',
              intent: 'order',
              subject: { reference: `Patient/${patientId}` },
              code: {
                coding: [{ system: 'http://www.ama-assn.org/go/cpt', code, display }]
              }
            }
          }
        ]
      }
    }
  };
}

const MOCK_ORDER_SIGN_CARDS = {
  cards: [
    {
      summary: 'Required',
      indicator: 'info',
      source: {
        label: 'UnitedHealthcarePriorAuthorizationRequirements',
        url: 'https://apimarketplace.uhcprovider.com/#/all-apis/prior-auth-api'
      },
      detail: 'A9521DMESUP/ACCESS/SRV-COMPON/OTHHCPCS'
    },
    {
      summary: 'Required',
      indicator: 'info',
      source: {
        label: 'UnitedHealthcarePriorAuthorizationRequirements',
        url: 'https://apimarketplace.uhcprovider.com/#/all-apis/prior-auth-api'
      },
      detail: '12367PREPSITEF/S/N/H/F/G/M/DGT1ST100SQCM/1PCT'
    }
  ],
  systemActions: []
};

export async function fetchOrderSignCard({ patientId, practitionerId, code, display }) {
  const mode = optumMode();
  if (mode === 'disabled') {
    const err = new Error('Optum integration disabled (OPTUM_ENABLED=off)');
    err.status = 501;
    throw err;
  }
  const hook = buildOrderSignHook({ patientId, practitionerId, code, display });
  if (mode !== 'live') {
    return { mode, hook, cards: MOCK_ORDER_SIGN_CARDS };
  }
  const url = `${PRIOR_AUTH_BASE}/cdsHooksServer/${PAYER_ID}/${PRIOR_AUTH_LOB}/api/cds-services/crd-order-sign`;
  const cards = await optumFetch(url, { method: 'POST', body: hook });
  return { mode: 'live', hook, cards };
}

// ---- 2. DTR Questionnaire package -------------------------------------

// Trimmed from a real capture: full item list preserved so the DTR
// reference panel shows genuine question text, just fewer answerOptions.
const MOCK_QUESTIONNAIRE_PACKAGE = {
  resourceType: 'Parameters',
  parameter: [
    {
      name: 'PackageBundle',
      resource: {
        resourceType: 'Bundle',
        type: 'collection',
        entry: [
          {
            resource: {
              resourceType: 'Questionnaire',
              id: 'ced12220-b903-47df-81cf-f7e654854b0a',
              url: 'http://example.org/fhir/Questionnaire/echocardiogram-prior-auth',
              title: 'Echocardiogram Prior Authorization Questionnaire',
              status: 'active',
              publisher: 'Example Payer Organization',
              description:
                'Collects information required for prior authorization of an echocardiogram due to family history of sudden cardiac death.',
              item: [
                { linkId: '1', text: 'Patient Identifier', type: 'string', required: true },
                { linkId: '2', text: 'Ordering Provider Name', type: 'string', required: true },
                { linkId: '3', text: 'Ordering Provider NPI', type: 'string', required: true },
                { linkId: '4', text: 'Diagnosis Code', type: 'choice', required: true },
                {
                  linkId: '5',
                  text: 'Clinical Justification for Echocardiogram',
                  type: 'text',
                  required: true
                },
                {
                  linkId: '6',
                  text: 'Has the patient experienced any symptoms (e.g., chest pain, syncope)?',
                  type: 'boolean',
                  required: true
                },
                { linkId: '10', text: 'Requested CPT Code', type: 'open-choice', required: true },
                {
                  linkId: '11',
                  text: "Please attach the report from the patient's most recent chest x-ray",
                  type: 'attachment',
                  required: true
                }
              ]
            }
          }
        ]
      }
    }
  ]
};

export async function fetchQuestionnairePackage({ patientId }) {
  const mode = optumMode();
  if (mode === 'disabled') {
    const err = new Error('Optum integration disabled (OPTUM_ENABLED=off)');
    err.status = 501;
    throw err;
  }
  if (mode !== 'live') {
    return { mode, patientId, response: MOCK_QUESTIONNAIRE_PACKAGE };
  }
  const url = `${PRIOR_AUTH_BASE}/fhirpa/R4/${PAYER_ID}/${PRIOR_AUTH_LOB}/Questionnaire/$questionnaire-package`;
  // Documented shape: `coverage` + `context` (valueString uuid). Our
  // earlier `patient` parameter worked live, but the OAS example does
  // not carry a patient parameter here -- the context uuid is what the
  // spec calls for and it matches every documented example we captured.
  // patientId is preserved in the returned envelope for logging.
  const contextUuid = crypto.randomUUID();
  const body = {
    resourceType: 'Parameters',
    parameter: [
      { name: 'coverage', resource: { resourceType: 'Coverage', id: 'cov-1', status: 'active' } },
      { name: 'context', valueString: contextUuid }
    ]
  };
  const response = await optumFetch(url, { method: 'POST', body });
  return { mode: 'live', patientId, contextUuid, response };
}

// ---- 3. PAS Claim/$submit ---------------------------------------------

const MOCK_CLAIM_SUBMIT_RESPONSE = {
  resourceType: 'Bundle',
  entry: [
    {
      resource: {
        resourceType: 'ClaimResponse',
        meta: {
          profile: ['http://hl7.org/fhir/us/davinci-pas/StructureDefinition-profile-claimresponse-base.html']
        },
        status: 'draft',
        type: { coding: [{ code: 'professional' }] },
        use: 'preauthorization',
        created: new Date().toISOString(),
        outcome: 'queued',
        disposition: 'Open',
        preAuthPeriod: { start: '2015-01-15', end: '2016-01-15' },
        item: [
          {
            itemSequence: 1,
            adjudication: [{ category: { coding: [{ code: 'submitted' }] } }]
          }
        ]
      },
      search: { mode: 'match' }
    }
  ]
};

export async function submitClaim(bundle) {
  const mode = optumMode();
  if (mode === 'disabled') {
    const err = new Error('Optum integration disabled (OPTUM_ENABLED=off)');
    err.status = 501;
    throw err;
  }
  if (mode !== 'live') {
    return { mode, response: MOCK_CLAIM_SUBMIT_RESPONSE };
  }
  const url = `${PRIOR_AUTH_BASE}/fhirpa/R4/${PAYER_ID}/${PRIOR_AUTH_LOB}/Claim/$submit`;
  const response = await optumFetch(url, { method: 'POST', body: bundle });
  return { mode: 'live', response };
}

// ---- 4. Provider Access $bulk-member-match ----------------------------

// Trimmed from Optum's OAS 200 response example -- three-group shape
// (Matched / NonMatched / ConsentConstrained), each Group's `member` list
// carrying an `extension` back-reference to a contained Patient with the
// demographics we submitted. Kept as a realistic canned response so mock
// mode matches the shape live mode returns.
const MOCK_BULK_MEMBER_MATCH = {
  resourceType: 'Parameters',
  id: 'provider-bulk-member-match-out',
  meta: {
    profile: [
      'http://hl7.org/fhir/us/davinci-pdex/StructureDefinition/provider-parameters-multi-member-match-bundle-out'
    ]
  },
  parameter: [
    {
      name: 'MatchedMembers',
      resource: {
        resourceType: 'Group',
        id: 'provider-matched-group-001',
        contained: [
          {
            resourceType: 'Patient',
            id: 'provider-submitted-patient-1',
            identifier: [
              {
                type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] },
                system: 'http://example.org/provider-emr/identifiers/patient',
                value: 'EMR-98765'
              }
            ],
            name: [{ family: 'Person', given: ['givenName', 'givenName2'] }],
            gender: 'female',
            birthDate: '1974-12-25'
          },
          {
            resourceType: 'Patient',
            id: 'provider-submitted-patient-2',
            identifier: [
              {
                type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] },
                system: 'http://example.org/provider-emr/identifiers/patient',
                value: 'EMR-45678'
              }
            ],
            name: [{ family: 'Doe', given: ['John', 'Michael'] }],
            gender: 'male',
            birthDate: '1985-06-15'
          }
        ],
        type: 'person',
        actual: true,
        code: {
          coding: [
            {
              system: 'http://hl7.org/fhir/us/davinci-pdex/CodeSystem/PdexMultiMemberMatchResultCS',
              code: 'match',
              display: 'Matched'
            }
          ]
        },
        managingEntity: {
          identifier: { system: 'http://hl7.org/fhir/sid/us-npi', value: '1234567890' },
          display: 'Example Health Plan'
        },
        member: [
          {
            entity: {
              extension: [
                {
                  url: 'http://hl7.org/fhir/us/davinci-pdex/StructureDefinition/base-ext-match-parameters',
                  valueReference: { reference: '#provider-submitted-patient-1' }
                }
              ],
              reference: 'Patient/payer-patient-1001',
              display: 'GivenName LastName - Payer Record'
            }
          },
          {
            entity: {
              extension: [
                {
                  url: 'http://hl7.org/fhir/us/davinci-pdex/StructureDefinition/base-ext-match-parameters',
                  valueReference: { reference: '#provider-submitted-patient-2' }
                }
              ],
              reference: 'Patient/payer-patient-2002',
              display: 'John Michael Doe - Payer Record'
            }
          }
        ]
      }
    },
    {
      name: 'NonMatchedMembers',
      resource: {
        resourceType: 'Group',
        id: 'provider-nomatch-group-001',
        contained: [
          {
            resourceType: 'Patient',
            id: 'provider-submitted-patient-3',
            identifier: [
              {
                type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] },
                system: 'http://example.org/provider-emr/identifiers/patient',
                value: 'EMR-99999'
              }
            ],
            name: [{ family: 'Smith', given: ['GivenName', 'GivenName2'] }],
            gender: 'female',
            birthDate: '1990-03-20'
          }
        ],
        type: 'person',
        actual: true,
        code: {
          coding: [
            {
              system: 'http://hl7.org/fhir/us/davinci-pdex/CodeSystem/PdexMultiMemberMatchResultCS',
              code: 'nomatch',
              display: 'Not Matched'
            }
          ]
        },
        member: [
          {
            entity: {
              extension: [
                {
                  url: 'http://hl7.org/fhir/us/davinci-pdex/StructureDefinition/base-ext-match-parameters',
                  valueReference: { reference: '#provider-submitted-patient-3' }
                }
              ],
              reference: '#provider-submitted-patient-3',
              display: 'GivenName GivenName2 Smith - Not Found'
            }
          }
        ]
      }
    },
    {
      name: 'ConsentConstrainedMembers',
      resource: {
        resourceType: 'Group',
        id: 'provider-consent-constraint-group-001',
        contained: [
          {
            resourceType: 'Patient',
            id: 'provider-submitted-patient-4',
            identifier: [
              {
                type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] },
                system: 'http://example.org/provider-emr/identifiers/patient',
                value: 'EMR-77777'
              }
            ],
            name: [{ family: 'Wilson', given: ['GivenName', 'GivenName2'] }],
            gender: 'male',
            birthDate: '1978-11-30'
          }
        ],
        type: 'person',
        actual: true,
        code: {
          coding: [
            {
              system: 'http://hl7.org/fhir/us/davinci-pdex/CodeSystem/PdexMultiMemberMatchResultCS',
              code: 'consentconstraint',
              display: 'Consent Constraint'
            }
          ]
        },
        member: [
          {
            entity: {
              extension: [
                {
                  url: 'http://hl7.org/fhir/us/davinci-pdex/StructureDefinition/base-ext-match-parameters',
                  valueReference: { reference: '#provider-submitted-patient-4' }
                }
              ],
              reference: '#provider-submitted-patient-4',
              display: 'GivenName GivenName2 Wilson - Opted Out'
            }
          }
        ]
      }
    }
  ]
};

// Canonical Da Vinci PDex multi-member-match request shape (empirically
// confirmed against Optum's OAS 2026-08-18). Every submission has three
// parts under a single MembersToMatch parameter: MemberPatient,
// CoverageToMatch, and a provider treatment-relationship Consent (the
// last of these is what the multi-member-match-bundle-in profile
// requires and the old flat-parameter shape omitted).
//
// Accepts either:
//   - a demo patient from lib/patients.js (the four BCBSIL test patients)
//   - a sandbox member from lib/optumSandboxMembers.js (Optum's own
//     canned demographics that the sandbox recognizes as matches)
// The Consent for demo patients is synthesized generically; sandbox
// members carry their own Consent verbatim from the OAS example.
function buildBulkMemberMatchParameters(subject) {
  const isSandboxMember = Boolean(subject.memberPatient);

  const memberPatient = isSandboxMember
    ? subject.memberPatient
    : {
        resourceType: 'Patient',
        id: `patient-${subject.id}`,
        name: [{ use: 'official', family: subject.family, given: subject.given }],
        birthDate: subject.dob,
        gender: subject.gender
      };

  const coverageToMatch = isSandboxMember
    ? subject.coverageToMatch
    : {
        resourceType: 'Coverage',
        id: `coverage-${subject.id}`,
        status: 'active',
        subscriberId: subject.subscriberId,
        beneficiary: { reference: `Patient/patient-${subject.id}`, display: subject.name },
        relationship: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/subscriber-relationship', code: 'self' }]
        },
        payor: [{ display: 'Blue Cross Blue Shield of Illinois' }]
      };

  const consent = isSandboxMember
    ? subject.consent
    : {
        resourceType: 'Consent',
        id: `consent-${subject.id}`,
        status: 'active',
        scope: {
          coding: [{ system: 'http://terminology.hl7.org/CodeSystem/consentscope', code: 'treatment' }]
        },
        category: [
          {
            coding: [
              { system: 'http://loinc.org', code: '64292-6', display: 'Release of information consent' }
            ]
          }
        ],
        patient: { reference: `Patient/patient-${subject.id}` },
        dateTime: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        provision: {
          type: 'permit',
          purpose: [
            { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'TREAT' },
            { system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HPAYMT' }
          ]
        }
      };

  return {
    resourceType: 'Parameters',
    id: 'provider-bulk-member-match-in',
    meta: {
      profile: [
        'http://hl7.org/fhir/us/davinci-pdex/StructureDefinition/provider-parameters-multi-member-match-bundle-in'
      ]
    },
    parameter: [
      {
        name: 'MembersToMatch',
        part: [
          { name: 'MemberPatient', resource: memberPatient },
          { name: 'CoverageToMatch', resource: coverageToMatch },
          { name: 'Consent', resource: consent }
        ]
      }
    ]
  };
}

export async function bulkMemberMatch(subject) {
  const mode = optumMode();
  if (mode === 'disabled') {
    const err = new Error('Optum integration disabled (OPTUM_ENABLED=off)');
    err.status = 501;
    throw err;
  }
  const request = buildBulkMemberMatchParameters(subject);
  if (mode !== 'live') {
    return { mode, request, response: MOCK_BULK_MEMBER_MATCH };
  }
  const url = `${PROVIDER_ACCESS_BASE}/R4/${PAYER_ID}/${PROVIDER_ACCESS_LOB}/Group/$bulk-member-match`;
  const response = await optumFetch(url, { method: 'POST', body: request });
  return { mode: 'live', request, response };
}

// ---- 5. Provider Access $davinci-data-export chain --------------------
//
// Async bulk-export flow following the captured OAS examples:
//   1. POST Group/{groupId}/$davinci-data-export     -> 200/202 with
//      an OperationOutcome body; polling URL is in the Content-Location
//      response HEADER, not the body.
//   2. GET .../$bulk-member-match-status/{jobId}     -> manifest with
//      output[]/error[] arrays of NDJSON file URLs.
//   3. GET .../download/Group/{fileName}/...         -> line-per-resource
//      NDJSON. Mock mode returns a single Patient line so the UI has
//      something to render.

const MOCK_EXPORT_KICKOFF_OUTCOME = {
  resourceType: 'OperationOutcome',
  issue: [
    {
      severity: 'information',
      code: 'informational',
      diagnostics:
        "The request has been created successfully. Polling Location is present in the 'Content-Location' header."
    }
  ]
};

// Mock a plausible jobId + Content-Location so the three-step UI can
// walk the chain without hitting a real endpoint.
const MOCK_EXPORT_JOB_ID = 'mock-export-job-0001';
const MOCK_EXPORT_MANIFEST = {
  transactionTime: '2021-01-01T00:00:00Z',
  request: `${PROVIDER_ACCESS_BASE}/R4/${PAYER_ID}/${PROVIDER_ACCESS_LOB}/Group/provider-matched-group-001/$davinci-data-export`,
  requiresAccessToken: true,
  output: [{ type: 'Patient', url: `mock://Patient_file_1.ndjson` }],
  error: [{ type: 'OperationOutcome', url: `mock://error_file_1.ndjson` }]
};
const MOCK_EXPORT_NDJSON_LINE = JSON.stringify({
  resourceType: 'Patient',
  id: '5c41cecf-cf81-434f-9da7-e24e5a99dbc2',
  name: [{ given: ['givenName'], family: ['familyName'] }],
  gender: 'female',
  birthDate: '1956-10-14T00:00:00.000Z'
});

export async function kickoffDavinciExport(groupId) {
  const mode = optumMode();
  if (mode === 'disabled') {
    const err = new Error('Optum integration disabled (OPTUM_ENABLED=off)');
    err.status = 501;
    throw err;
  }
  if (mode !== 'live') {
    return {
      mode,
      groupId,
      status: 202,
      contentLocation: `mock://status/${MOCK_EXPORT_JOB_ID}`,
      jobId: MOCK_EXPORT_JOB_ID,
      response: MOCK_EXPORT_KICKOFF_OUTCOME
    };
  }
  const url = `${PROVIDER_ACCESS_BASE}/R4/${PAYER_ID}/${PROVIDER_ACCESS_LOB}/Group/${encodeURIComponent(groupId)}/$davinci-data-export`;
  const token = await getToken();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      environment: 'sandbox',
      'x-optum-consumer-correlation-id': correlationId()
    }
  });
  const text = await res.text();
  let response;
  try {
    response = text ? JSON.parse(text) : null;
  } catch {
    response = { _rawText: text };
  }
  if (!res.ok) {
    const err = new Error(`Optum $davinci-data-export kickoff error: ${res.status}`);
    err.status = res.status;
    err.body = response;
    throw err;
  }
  const contentLocation = res.headers.get('content-location') || res.headers.get('Content-Location') || null;
  // Try to extract a jobId from the tail of the polling URL for the UI.
  const jobId = contentLocation ? contentLocation.split('/').pop() : null;
  return { mode: 'live', groupId, status: res.status, contentLocation, jobId, response };
}

export async function pollExportStatus(jobId) {
  const mode = optumMode();
  if (mode === 'disabled') {
    const err = new Error('Optum integration disabled (OPTUM_ENABLED=off)');
    err.status = 501;
    throw err;
  }
  if (mode !== 'live') {
    return { mode, jobId, status: 200, response: MOCK_EXPORT_MANIFEST };
  }
  const url = `${PROVIDER_ACCESS_BASE}/R4/${PAYER_ID}/${PROVIDER_ACCESS_LOB}/$bulk-member-match-status/${encodeURIComponent(jobId)}`;
  const token = await getToken();
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      environment: 'sandbox',
      'x-optum-consumer-correlation-id': correlationId()
    }
  });
  const text = await res.text();
  let response;
  try {
    response = text ? JSON.parse(text) : null;
  } catch {
    response = { _rawText: text };
  }
  if (!res.ok) {
    const err = new Error(`Optum export status error: ${res.status}`);
    err.status = res.status;
    err.body = response;
    throw err;
  }
  return { mode: 'live', jobId, status: res.status, response };
}

export async function downloadExportFile(fileName) {
  const mode = optumMode();
  if (mode === 'disabled') {
    const err = new Error('Optum integration disabled (OPTUM_ENABLED=off)');
    err.status = 501;
    throw err;
  }
  if (mode !== 'live') {
    return { mode, fileName, resources: [JSON.parse(MOCK_EXPORT_NDJSON_LINE)], rawNdjson: MOCK_EXPORT_NDJSON_LINE };
  }
  const url = `${PROVIDER_ACCESS_BASE}/R4/${PAYER_ID}/${PROVIDER_ACCESS_LOB}/download/Group/${encodeURIComponent(fileName)}/$davinci-data-export`;
  const token = await getToken();
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/fhir+ndjson',
      environment: 'sandbox',
      'x-optum-consumer-correlation-id': correlationId()
    }
  });
  const text = await res.text();
  if (!res.ok) {
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { _rawText: text };
    }
    const err = new Error(`Optum export download error: ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  // NDJSON: one JSON resource per non-empty line.
  const resources = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { _unparsed: line };
      }
    });
  return { mode: 'live', fileName, resources, rawNdjson: text };
}
