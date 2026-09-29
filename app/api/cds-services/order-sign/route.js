import { NextResponse } from 'next/server';
import { getDb, logTransaction } from '@/lib/db';
import { PATIENT_LIST } from '@/lib/patients';
import { resolveRouting, conditionCodes } from '@/lib/routing';
import { DRUG_BY_HCPCS, questionnaireIdForDrug } from '@/lib/drugPa';
import { withUsage } from '@/lib/withUsage';
import { coverageInformationOrder } from '@/lib/fhir';

/**
 * CDS Hooks 2.0 `order-sign` service.
 *
 * Implements two-pass matching (code → category), conditional UM routing,
 * a CDS Hooks 2.0–conformant card (info / warning / critical / hard-stop),
 * and a Da Vinci CRD STU 2.2.1 `coverage-information` system action.
 *
 * Honest framing: this is a simulator. We treat the inbound payload as a
 * slightly relaxed CDS Hook envelope so the demo UI stays small. A
 * production endpoint would parse a full Hook context with prefetch.
 */

const HARD_STOP_FLAG = 'hard-stop-trigger';

const SOURCE_DEFAULT = {
  label: 'BCBSIL 2026 PA Grids',
  url: 'https://www.bcbsil.com/provider/clinical/prior-auth',
  icon: 'https://www.bcbsil.com/favicon.ico'
};

// When a rule was extracted from an uploaded grid PDF, prefer the filename
// for the card's source. Falls back to the generic default for seed rules.
function sourceForRule(rule) {
  if (rule && rule.source_file) {
    return {
      label: rule.source_file,
      url: SOURCE_DEFAULT.url,
      icon: SOURCE_DEFAULT.icon
    };
  }
  return SOURCE_DEFAULT;
}

// ---- Plan-type filtering --------------------------------------------------
// Pre-ingested rules use source_label ("Medicare Advantage", "Commercial
// Med-Surg", etc.) rather than an explicit plan_type field. Map the EHR's
// plan_type selection to the correct subset. BH and Specialty Pharmacy
// grids apply across all plan types.

function ruleMatchesPlan(rule, planType) {
  if (rule.plan_type) return rule.plan_type === planType; // explicit wins
  const label = (rule.source_label || '').toLowerCase();
  if (!label) return true; // no provenance → universal
  const isMa = label.includes('medicare');
  if (planType === 'MA-PPO') return isMa || (!label.includes('commercial') && !label.includes('medsurg') && !label.includes('med-surg') && !label.includes('med surg'));
  // QHP individual-market coverage uses the commercial grids.
  if (planType === 'COMM-PPO' || planType === 'COMM-HMO' || planType === 'QHP-FFE') return !isMa;
  // No Medicaid PA grid is ingested, so no grid rule applies to Medicaid.
  if (planType === 'MEDICAID-MCO') return false;
  return true;
}

// ---- Rule resolution ------------------------------------------------------
// Cascade: gold-card → code → category → service_categories.default_rule →
// plans.requires_pa_by_default. Earlier matches win.

function findGoldCardExemption(programs, orderedCode, practitionerNpi) {
  if (!programs?.length || !orderedCode) return null;
  for (const g of programs) {
    if (!g.code_scope?.includes(orderedCode)) continue;
    // If providers list is non-empty, require the practitioner NPI to be
    // enrolled, so a request without an NPI is not exempted. If empty,
    // treat as program-wide pilot (still exempted).
    if (g.providers?.length && (!practitionerNpi || !g.providers.includes(practitionerNpi))) continue;
    return g;
  }
  return null;
}

function findCategoryDefault(serviceCategories, orderedCode, serviceCategoryName) {
  if (!serviceCategories?.length) return null;
  for (const sc of serviceCategories) {
    // Match either by code list or by category-name string contains
    const inCodes = sc.codes?.some((c) => c.code === orderedCode);
    const nameMatch = serviceCategoryName &&
      sc.category_name?.toLowerCase().includes(serviceCategoryName.toLowerCase());
    if (inCodes || nameMatch) {
      return { category: sc, default_rule: sc.default_rule };
    }
  }
  return null;
}

function findRule(rules, orderedCode, serviceCategory) {
  // Pass 1: code match.
  const byCode = rules.find(
    (r) => r.match_type === 'code' && r.service_code === orderedCode
  );
  if (byCode) return { rule: byCode, pass: 'code' };

  // Pass 2: category match (free-text substring).
  if (serviceCategory) {
    const needle = serviceCategory.toLowerCase();
    const byCategory = rules.find(
      (r) =>
        r.match_type === 'category' &&
        r.service_category &&
        (r.service_category.toLowerCase().includes(needle) ||
          needle.includes(r.service_category.toLowerCase()))
    );
    if (byCategory) return { rule: byCategory, pass: 'category' };
  }

  return { rule: null, pass: 'none' };
}

// ---- Indicator selection ---------------------------------------------------

function pickIndicator(rule, hardStopRequested) {
  if (hardStopRequested) return 'hard-stop';
  if (!rule) return 'warning'; // unknown code — fallback warning
  if (rule.pa_needed === 'no-auth') return 'info';

  const docs = rule.documentation_requirements || '';
  const highComplexity =
    rule.managed_by === 'Carelon-or-BCBSIL-conditional' ||
    /functional impairment/i.test(docs);

  return highComplexity ? 'critical' : 'warning';
}

// ---- coverage-information system action (Da Vinci CRD STU 2.2.1) ----------

function buildCoverageInformationAction({
  patientId,
  coverageId,
  orderedCode,
  serviceCategory,
  rule,
  routing,
  paNeededValue,
  goldCard,
  categoryDefault,
  hardStop,
  orderId,
  unreadableOrder
}) {
  // pa-needed mapping:
  //   no-PA rule           → 'no-auth'
  //   auth-needed @ Phase 2 → 'auth-needed'
  //   gold card             → 'satisfied', with the program as the PA id
  //   auth-needed @ Phase 4 → 'satisfied' (emitted in pas/submit, not here)
  // The order must agree with the card: a gold card is covered, and a
  // category default carries its own covered value.
  const covered =
    goldCard
      ? 'covered'
      : hardStop
      ? 'not-covered'
      : unreadableOrder
      ? 'conditional'
      : !rule && categoryDefault
      ? categoryDefault.default_rule?.covered || 'covered'
      : rule?.managed_by === 'Carelon-or-BCBSIL-conditional' && !routing.reason
      ? 'conditional'
      : routing.covered || 'covered';

  return {
    type: 'update',
    description: 'Coverage information for ordered service',
    resource: coverageInformationOrder({
      orderId,
      patientId,
      orderedCode,
      serviceText: serviceCategory,
      coverageId,
      covered,
      paNeeded: paNeededValue,
      satisfiedPaId: goldCard ? `GOLDCARD-${String(goldCard.program_name || 'program').replace(/[^A-Za-z0-9]+/g, '-').toUpperCase()}` : null
    })
  };
}

// ---- Handler ---------------------------------------------------------------

async function handlePOST(request) {
  const body = await request.json();

  // Accept either a CDS-Hooks-shaped payload or the simulator's relaxed shape.
  const str = (v, max = 64) => (typeof v === 'string' && v && v.length <= max ? v : null);
  // CDS Hooks order-sign sends the order in context.draftOrders. When it
  // is there, the coverage-information update targets that order's id.
  // The first ServiceRequest among the draft orders. Its CPT or HCPCS coding
  // is the ordered code. Another order type is not treated as a service.
  const draftEntries = Array.isArray(body.context?.draftOrders?.entry) ? body.context.draftOrders.entry : [];
  const draftOrder = draftEntries.map((e) => e?.resource).find((r) => r?.resourceType === 'ServiceRequest') || null;
  const draftOrderId = typeof draftOrder?.id === 'string' ? draftOrder.id : null;
  // CPT or HCPCS, whether the client writes the system with http or https.
  const BILLING_SYSTEMS = ['www.ama-assn.org/go/cpt', 'www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets'];
  const schemeless = (v) => (typeof v === 'string' ? v.replace(/^https?:\/\//, '') : '');
  const draftCode = (Array.isArray(draftOrder?.code?.coding) ? draftOrder.code.coding : []).find((c) => BILLING_SYSTEMS.includes(schemeless(c?.system)))?.code;
  // The sandbox EHR sends code and patientId at the top level. A CDS Hooks
  // client sends them in context (draftOrders, patientId) and prefetch.
  const orderedCode = str(body.code) || str(body.serviceCode) || str(draftCode);
  const serviceCategory = str(body.serviceCategory, 200);
  const planType = str(body.planType);
  // A prefetch that failed arrives as an OperationOutcome, so only a real
  // Patient is used. context.patientId outranks the prefetch.
  const prefetchPatient = body.prefetch?.patient?.resourceType === 'Patient' ? body.prefetch.patient : null;
  // Ids go into Patient/ and Coverage/ references, so only FHIR ids.
  const fhirId = (v) => (typeof v === 'string' && /^[A-Za-z0-9.-]{1,64}$/.test(v) ? v : null);
  const patientId =
    fhirId(body.patient?.id) || fhirId(body.patientResource?.id) || fhirId(body.patientId) ||
    fhirId(body.context?.patientId) || fhirId(prefetchPatient?.id) || 'unknown';
  // The advertised coverage prefetch is a search Bundle of Coverage.
  const prefetchCoverage = Array.isArray(body.prefetch?.coverage?.entry)
    ? body.prefetch.coverage.entry.map((e) => e?.resource).find((r) => r?.resourceType === 'Coverage')
    : null;
  const coverageId = fhirId(body.coverage?.id) || fhirId(body.coverageId) || fhirId(prefetchCoverage?.id) || 'unknown';
  const hardStopRequested = Boolean(body[HARD_STOP_FLAG]);
  // Draft orders the payer cannot read (no ServiceRequest with a CPT or
  // HCPCS coding, for example only a MedicationRequest) get no coverage
  // answer, rather than a "not on the grid" no-auth.
  const unreadableOrder = draftEntries.length > 0 && !orderedCode && !serviceCategory;
  // A CDS Hooks client names the user as context.userId (Practitioner/<id>).
  // The demo practitioners' NPIs come from lib/patients.js.
  const userPractitionerId = typeof body.context?.userId === 'string' ? body.context.userId.replace(/^Practitioner\//, '') : null;
  const npiFromUser = userPractitionerId ? PATIENT_LIST.find((p) => p.practitioner?.id === userPractitionerId)?.npi || null : null;
  const practitionerNpi = str(body.practitionerNpi) || str(body.npi) || npiFromUser;

  logTransaction(
    'CRD Gateway',
    'HOOK RECEIVED',
    `order-sign for Patient/${patientId}, code=${orderedCode || '—'}, category=${serviceCategory || '—'}${hardStopRequested ? ' [hard-stop debug]' : ''}`,
    { npi: practitionerNpi, patientId, code: orderedCode }
  );

  const db = getDb();
  const rules = planType ? db.rules.filter((r) => ruleMatchesPlan(r, planType)) : db.rules;

  // Gold-card check runs BEFORE rule matching — an exempted provider gets
  // pa_needed='satisfied' even if the code is on the PA list.
  const goldCard = findGoldCardExemption(db.gold_card_programs, orderedCode, practitionerNpi);

  const { rule, pass } = findRule(rules, orderedCode, serviceCategory);
  const categoryDefault = !rule
    ? findCategoryDefault(db.service_categories, orderedCode, serviceCategory)
    : null;
  // Cascade step 5: a plan that requires PA by default (COMM-HMO) needs it
  // for a code with no grid rule and no category default.
  const planDefault =
    !goldCard && !rule && !categoryDefault && !unreadableOrder
      ? (db.plans || []).find((p) => p.plan_type === planType && p.requires_pa_by_default) || null
      : null;

  // Diagnoses travel with the hook as Condition resources (R4 Patient has
  // no condition element).
  const routing = resolveRouting(rule, conditionCodes(body.conditions));
  const indicator = goldCard ? 'info' : pickIndicator(rule, hardStopRequested);

  // ----- Build card -------------------------------------------------------
  let card;

  if (goldCard) {
    card = {
      summary: 'Prior authorization satisfied (gold-card exemption)',
      indicator: 'info',
      detail:
        `**${orderedCode}** is on the PA list but the ordering provider qualifies under the ` +
        `**${goldCard.program_name}**. ${goldCard.eligibility} ` +
        `PA is auto-satisfied; no further documentation required.`,
      source: sourceForRule(rule)
    };
  } else if (hardStopRequested) {
    card = {
      summary: 'Order blocked: non-overridable payer decision',
      indicator: 'hard-stop',
      detail:
        `Service **${rule?.description || orderedCode || serviceCategory || 'requested'}** is flagged by the payer as a non-covered or contraindicated scenario. ` +
        `Reviewed by **${routing.vendor}**. The CDS Hooks 2.0 \`hard-stop\` indicator is non-overridable; the EHR must disable order-sign.`,
      source: sourceForRule(rule)
    };
  } else if (!rule && categoryDefault) {
    const def = categoryDefault.default_rule || {};
    card = {
      summary: `Category default (${categoryDefault.category.category_name})`,
      indicator: def.pa_needed === 'auth-needed' ? 'warning' : 'info',
      detail:
        `No code-specific rule for **${orderedCode}**, but it falls under the ` +
        `**${categoryDefault.category.category_name}** service category. ` +
        `Category default: covered=${def.covered}, pa_needed=${def.pa_needed}.`,
      source: sourceForRule(rule)
    };
  } else if (!rule && planDefault) {
    card = {
      summary: 'Prior authorization required (plan default)',
      indicator: 'warning',
      detail:
        `No grid rule for **${orderedCode || serviceCategory || 'this service'}**, but ${planDefault.name || planType} ` +
        'requires prior authorization by default. Complete the medical necessity Questionnaire before order-sign.',
      source: sourceForRule(rule),
      links: [
        {
          label: 'Launch DTR SMART App',
          url: `/dtr/launch?questionnaire=fallback-medical-necessity&code=${encodeURIComponent(orderedCode || '')}`,
          type: 'smart',
          appContext: JSON.stringify({ questionnaireId: 'fallback-medical-necessity', cqlLibraryId: null, orderedCode, managedBy: routing.vendor })
        }
      ]
    };
  } else if (unreadableOrder) {
    card = {
      summary: 'Ordered code could not be read',
      indicator: 'warning',
      detail:
        'The draft order carries no CPT or HCPCS coding, so the payer could not evaluate it. ' +
        'Resend the order with a CPT or HCPCS code to get a coverage answer.',
      source: sourceForRule(rule)
    };
  } else if (!rule) {
    card = {
      summary: 'Code not on the active PA grid',
      indicator,
      detail:
        `No matching rule found for **${orderedCode || 'the ordered service'}**` +
        (serviceCategory ? ` (category: ${serviceCategory})` : '') +
        '. The order may proceed; no payer documentation requested.',
      source: sourceForRule(rule)
    };
  } else if (rule.pa_needed === 'no-auth') {
    card = {
      summary: 'No prior authorization required',
      indicator,
      detail: `Service **${rule.description}** is covered without prior authorization. Reviewed by **${routing.vendor}**.`,
      source: sourceForRule(rule)
    };
  } else {
    // Drug codes bind the questionnaire generated from the shared drug PA
    // model, in place of the grid's generic fallback.
    const questId =
      questionnaireIdForDrug(Object.hasOwn(DRUG_BY_HCPCS, String(orderedCode)) ? DRUG_BY_HCPCS[orderedCode] : null) ||
      rule.questionnaire_id ||
      'fallback-medical-necessity';
    const dtrUrl = `/dtr/launch?questionnaire=${encodeURIComponent(questId)}&code=${encodeURIComponent(orderedCode)}`;
    card = {
      summary: 'Prior authorization required',
      indicator,
      detail:
        `Prior authorization required for **${rule.description}**. ` +
        `Reviewed by **${routing.vendor}**${routing.reason ? ` — ${routing.reason}` : ''}. ` +
        `Complete the bound Questionnaire (\`${questId}\`) before order-sign.`,
      source: sourceForRule(rule),
      links: [
        {
          label: 'Launch DTR SMART App',
          url: dtrUrl,
          type: 'smart',
          appContext: JSON.stringify({
            questionnaireId: questId,
            cqlLibraryId: rule.cql_library_id,
            orderedCode,
            managedBy: routing.vendor
          })
        }
      ]
    };
  }

  // ----- Build coverage-information system action -------------------------
  const paNeededValue = goldCard
    ? 'satisfied'
    : unreadableOrder
    ? 'conditional'
    : !rule && categoryDefault
    ? categoryDefault.default_rule?.pa_needed || 'no-auth'
    : planDefault
    ? 'auth-needed'
    : !rule || rule.pa_needed === 'no-auth'
    ? 'no-auth'
    : 'auth-needed';

  const systemAction = buildCoverageInformationAction({
    patientId,
    coverageId,
    orderedCode,
    serviceCategory,
    rule,
    routing,
    paNeededValue,
    goldCard,
    categoryDefault,
    // The hard-stop card blocks a non-covered order, so the order says so.
    hardStop: card?.indicator === 'hard-stop',
    orderId: draftOrderId,
    unreadableOrder
  });

  // This log line is the visible "machine-readable PA determination" moment
  // in the UM Dashboard live feed — separate from the human-readable card.
  logTransaction(
    'CRD Gateway',
    'COVERAGE-INFORMATION ACTION',
    JSON.stringify(systemAction.resource, null, 2),
    { npi: practitionerNpi, patientId, code: orderedCode }
  );

  logTransaction(
    'CRD Engine',
    'EVALUATION',
    `pass=${pass} code=${orderedCode || '—'} rule=${rule ? rule.description : '—'} indicator=${card.indicator} routed=${routing.vendor}`,
    { npi: practitionerNpi, patientId, code: orderedCode }
  );

  return NextResponse.json({
    cards: [card],
    systemActions: [systemAction]
  });
}

// Usage metrics (CMS-0062-P): one event per call, bucketed by outcome.
export const POST = withUsage('Prior Authorization', handlePOST);
