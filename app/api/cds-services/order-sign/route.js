import { NextResponse } from 'next/server';
import { getDb, logTransaction } from '@/lib/db';

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

// ---- Rule resolution ------------------------------------------------------
// Cascade: gold-card → code → category → service_categories.default_rule →
// plans.requires_pa_by_default. Earlier matches win.

function findGoldCardExemption(programs, orderedCode, practitionerNpi) {
  if (!programs?.length || !orderedCode) return null;
  for (const g of programs) {
    if (!g.code_scope?.includes(orderedCode)) continue;
    // If providers list is non-empty, require the practitioner NPI to be
    // enrolled. If empty, treat as program-wide pilot (still exempted).
    if (g.providers?.length && practitionerNpi && !g.providers.includes(practitionerNpi)) continue;
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

// ---- Routing resolution ----------------------------------------------------

function resolveRouting(rule, patient) {
  if (!rule) return { vendor: 'BCBSIL', covered: 'not-covered' };

  if (rule.managed_by !== 'Carelon-or-BCBSIL-conditional') {
    return { vendor: rule.managed_by, covered: 'covered' };
  }

  // Conditional: look for an oncology ICD-10 on the Patient's Condition list.
  const conditions = (patient && patient.condition) || [];
  const hasOncology = conditions.some((c) => {
    const code =
      c?.code?.coding?.[0]?.code ||
      c?.code?.text ||
      (typeof c === 'string' ? c : '');
    if (!code) return false;
    const first = code.charAt(0).toUpperCase();
    if (first !== 'C' && first !== 'D') return false;
    if (first === 'C') return true; // C00–C99 all neoplasms
    // D-block: only D00–D49 are neoplasms.
    const tens = parseInt(code.substring(1, 3), 10);
    return Number.isFinite(tens) && tens <= 49;
  });

  return {
    vendor: hasOncology ? 'Carelon' : 'BCBSIL',
    covered: 'covered',
    reason: hasOncology
      ? 'Patient has active oncology Condition (ICD-10 C00–D49); routed to Carelon.'
      : 'No oncology Condition present; routed to BCBSIL default UM.'
  };
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
  rule,
  routing,
  paNeededValue
}) {
  // pa-needed mapping:
  //   no-PA rule           → 'no-auth'
  //   auth-needed @ Phase 2 → 'auth-needed'
  //   auth-needed @ Phase 4 → 'satisfied' (emitted in pas/submit, not here)
  const covered =
    !rule
      ? 'not-covered'
      : rule.managed_by === 'Carelon-or-BCBSIL-conditional' && !routing.reason
      ? 'conditional'
      : routing.covered || 'covered';

  return {
    type: 'update',
    description: 'Coverage information for ordered service',
    resource: {
      resourceType: 'Task',
      status: 'ready',
      intent: 'proposal',
      code: {
        coding: [
          {
            system: 'http://hl7.org/fhir/us/davinci-crd/CodeSystem/temp',
            code: 'coverage-information'
          }
        ]
      },
      for: { reference: `Patient/${patientId}` },
      authoredOn: new Date().toISOString(),
      extension: [
        {
          url: 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information#coverage',
          valueReference: { reference: `Coverage/${coverageId || 'unknown'}` }
        },
        {
          url: 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information#covered',
          valueCode: covered
        },
        {
          url: 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information#pa-needed',
          valueCode: paNeededValue
        },
        {
          url: 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information#billingCode',
          valueCoding: {
            system: 'http://www.ama-assn.org/go/cpt',
            code: orderedCode
          }
        },
        {
          url: 'http://hl7.org/fhir/us/davinci-crd/StructureDefinition/ext-coverage-information#date',
          valueDateTime: new Date().toISOString()
        }
      ]
    }
  };
}

// ---- Handler ---------------------------------------------------------------

export async function POST(request) {
  const body = await request.json();

  // Accept either a CDS-Hooks-shaped payload or the simulator's relaxed shape.
  const orderedCode = body.code || body.serviceCode;
  const serviceCategory = body.serviceCategory || null;
  const patient = body.patient || body.patientResource || null;
  const patientId =
    (patient && patient.id) || body.patientId || 'unknown';
  const coverageId =
    (body.coverage && body.coverage.id) || body.coverageId || 'unknown';
  const hardStopRequested = Boolean(body[HARD_STOP_FLAG]);

  logTransaction(
    'CRD Gateway',
    'HOOK RECEIVED',
    `order-sign for Patient/${patientId}, code=${orderedCode}, category=${serviceCategory || '—'}${hardStopRequested ? ' [hard-stop debug]' : ''}`
  );

  const db = getDb();
  const rules = db.rules;

  // Gold-card check runs BEFORE rule matching — an exempted provider gets
  // pa_needed='satisfied' even if the code is on the PA list.
  const practitionerNpi = body.practitionerNpi || body.npi || null;
  const goldCard = findGoldCardExemption(db.gold_card_programs, orderedCode, practitionerNpi);

  const { rule, pass } = findRule(rules, orderedCode, serviceCategory);
  const categoryDefault = !rule
    ? findCategoryDefault(db.service_categories, orderedCode, serviceCategory)
    : null;

  const routing = resolveRouting(rule, patient);
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
  } else if (!rule) {
    card = {
      summary: 'Code not on the active PA grid',
      indicator,
      detail:
        `No matching rule found for **${orderedCode}**` +
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
  } else if (hardStopRequested) {
    card = {
      summary: 'Order blocked: non-overridable payer decision',
      indicator: 'hard-stop',
      detail:
        `Service **${rule.description}** is on the PA list and patient context indicates a non-covered or contraindicated scenario. ` +
        `Reviewed by **${routing.vendor}**. The CDS Hooks 2.0 \`hard-stop\` indicator is non-overridable; the EHR must disable order-sign.`,
      source: sourceForRule(rule)
    };
  } else {
    const dtrUrl = `/dtr/launch?questionnaire=${encodeURIComponent(rule.questionnaire_id)}&code=${encodeURIComponent(orderedCode)}`;
    card = {
      summary: 'Prior authorization required',
      indicator,
      detail:
        `Prior authorization required for **${rule.description}**. ` +
        `Reviewed by **${routing.vendor}**${routing.reason ? ` — ${routing.reason}` : ''}. ` +
        `Complete the bound Questionnaire (\`${rule.questionnaire_id}\`) before order-sign.`,
      source: sourceForRule(rule),
      links: [
        {
          label: 'Launch DTR SMART App',
          url: dtrUrl,
          type: 'smart',
          appContext: JSON.stringify({
            questionnaireId: rule.questionnaire_id,
            cqlLibraryId: rule.cql_library_id,
            orderedCode,
            managedBy: routing.vendor
          })
        }
      ]
    };

    // For indicator-info-style alternative suggestions: if rule is auth-needed
    // and the grid has a no-PA peer (e.g., 99214), surface it as an
    // alternative suggestion. Demo-pragmatic: just point at office-visit.
    const peer = rules.find((r) => r.pa_needed === 'no-auth' && r.match_type === 'code');
    if (peer) {
      card.suggestions = [
        {
          label: `Order an alternative no-PA service (${peer.service_code} — ${peer.description})`,
          uuid: `suggest-${peer.service_code}`,
          actions: [
            {
              type: 'update',
              description: `Swap the order to ${peer.service_code}`,
              resource: {
                resourceType: 'ServiceRequest',
                status: 'draft',
                intent: 'order',
                code: {
                  coding: [
                    { system: 'http://www.ama-assn.org/go/cpt', code: peer.service_code }
                  ]
                }
              }
            }
          ]
        }
      ];
    }
  }

  // ----- Build coverage-information system action -------------------------
  const paNeededValue =
    !rule || rule.pa_needed === 'no-auth' ? 'no-auth' : 'auth-needed';

  const systemAction = buildCoverageInformationAction({
    patientId,
    coverageId,
    orderedCode,
    rule,
    routing,
    paNeededValue
  });

  // This log line is the visible "machine-readable PA determination" moment
  // in the UM Dashboard live feed — separate from the human-readable card.
  logTransaction(
    'CRD Gateway',
    'COVERAGE-INFORMATION ACTION',
    JSON.stringify(systemAction.resource, null, 2)
  );

  logTransaction(
    'CRD Engine',
    'EVALUATION',
    `pass=${pass} code=${orderedCode} rule=${rule ? rule.description : '—'} indicator=${card.indicator} routed=${routing.vendor}`
  );

  return NextResponse.json({
    cards: [card],
    systemActions: [systemAction]
  });
}
