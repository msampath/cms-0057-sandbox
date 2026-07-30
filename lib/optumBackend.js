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
    return { mode, response: MOCK_QUESTIONNAIRE_PACKAGE };
  }
  const url = `${PRIOR_AUTH_BASE}/fhirpa/R4/${PAYER_ID}/${PRIOR_AUTH_LOB}/Questionnaire/$questionnaire-package`;
  const body = {
    resourceType: 'Parameters',
    parameter: [
      { name: 'coverage', resource: { resourceType: 'Coverage', id: 'cov-1', status: 'active' } },
      { name: 'patient', resource: { resourceType: 'Patient', id: patientId } }
    ]
  };
  const response = await optumFetch(url, { method: 'POST', body });
  return { mode: 'live', response };
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
        code: { coding: [{ code: 'match', display: 'Matched' }] },
        member: [
          { entity: { reference: 'Patient/payer-patient-1001', display: 'GivenName LastName - Payer Record' } },
          { entity: { reference: 'Patient/payer-patient-2002', display: 'John Michael Doe - Payer Record' } }
        ]
      }
    },
    {
      name: 'NonMatchedMembers',
      resource: {
        resourceType: 'Group',
        id: 'provider-nomatch-group-001',
        code: { coding: [{ code: 'nomatch', display: 'Not Matched' }] },
        member: []
      }
    },
    {
      name: 'ConsentConstrainedMembers',
      resource: {
        resourceType: 'Group',
        id: 'provider-consent-constraint-group-001',
        code: { coding: [{ code: 'consentconstraint', display: 'Consent Constraint' }] },
        member: []
      }
    }
  ]
};

export async function bulkMemberMatch() {
  const mode = optumMode();
  if (mode === 'disabled') {
    const err = new Error('Optum integration disabled (OPTUM_ENABLED=off)');
    err.status = 501;
    throw err;
  }
  if (mode !== 'live') {
    return { mode, response: MOCK_BULK_MEMBER_MATCH };
  }
  const url = `${PROVIDER_ACCESS_BASE}/R4/${PAYER_ID}/${PROVIDER_ACCESS_LOB}/Group/$bulk-member-match`;
  const body = { id: 'provider-bulk-member-match-in', resourceType: 'Parameters' };
  const response = await optumFetch(url, { method: 'POST', body });
  return { mode: 'live', response };
}
