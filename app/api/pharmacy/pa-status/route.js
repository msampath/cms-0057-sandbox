import { NextResponse } from 'next/server';
import { requireScopes } from '@/lib/auth';
import { PATIENT_ID_BY_SUBSCRIBER } from '@/lib/patients';
import { DRUG_CATALOG } from '@/lib/drugPa';
import { drugPriorAuthEobs } from '@/lib/drugPaAccess';
import { formularyLookup } from '@/lib/ncpdpGenerator';

export const dynamic = 'force-dynamic';

// A pharmacy reading PA status and benefit data for a member it is
// dispensing to. Backend-services scopes, like Provider Access.
const REQUIRED_SCOPES = ['system/ExplanationOfBenefit.read', 'system/Coverage.read'];

/**
 * GET /api/pharmacy/pa-status?memberId={subscriberId}&ndc={ndc}
 *
 * Pharmacy-facing PA status over an open standard (CMS-0062-P position 2:
 * status, benefit, and formulary information should reach pharmacies, not
 * only prescribers and members, and not only through proprietary portals).
 *
 * Returns a searchset Bundle of the member's PDex Prior Authorization EOBs
 * for that drug (both benefit tracks, so the pharmacy sees the same
 * decision and reason the prescriber saw), plus the RTPB and F&B results
 * from the pharmacy track. The benefit block is a demo envelope, like the
 * Patient Access response.
 */
export async function GET(request) {
  const denied = requireScopes(request, REQUIRED_SCOPES);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const memberId = searchParams.get('memberId');
  const ndc = (searchParams.get('ndc') || '').replace(/\D/g, '');
  if (!memberId || !ndc) {
    return NextResponse.json(
      { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid', diagnostics: 'memberId and ndc query parameters are required' }] },
      { status: 400 }
    );
  }
  const patientId = PATIENT_ID_BY_SUBSCRIBER[memberId];
  if (!patientId) {
    return NextResponse.json(
      { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found', diagnostics: `No member ${memberId}.` }] },
      { status: 404 }
    );
  }
  const drug = Object.values(DRUG_CATALOG).find((d) =>
    Object.values(d.siteOfCare).some((f) => f.ndc === ndc)
  );
  if (!drug) {
    return NextResponse.json(
      { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found', diagnostics: `NDC ${ndc} is not in the sandbox drug catalog.` }] },
      { status: 404 }
    );
  }

  // Both tracks for this drug. The medical-benefit (HCPCS) authorization is
  // included because it records the same decision and reason.
  const eobs = drugPriorAuthEobs(patientId).filter((e) => e.id.startsWith(`pa-${drug.key}-`));

  return NextResponse.json({
    memberId,
    drug: { key: drug.key, name: drug.name, ndc },
    benefit: {
      rtpb: { coverageStatus: 'Covered with restrictions', priorAuthorizationRequired: true, source: 'RTPB v13 (illustrative)' },
      formulary: formularyLookup(drug.key)
    },
    bundle: {
      resourceType: 'Bundle',
      type: 'searchset',
      timestamp: new Date().toISOString(),
      total: eobs.length,
      entry: eobs.map((resource) => ({ fullUrl: `urn:uuid:${crypto.randomUUID()}`, resource }))
    }
  });
}
