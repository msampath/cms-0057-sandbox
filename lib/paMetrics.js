import { getPaEvents, getDb, getApiUsage } from './db';
import { DRUG_CATALOG } from './drugPa';

/**
 * Prior authorization metrics (CMS-0062-P position 4: numeric counts
 * alongside percentages, drug PA metrics, public posting).
 *
 * Source: the PA decision events in lib/db.js. Every transaction log entry
 * that carries a `pa` tag (PAS submit, pended finalization, NCPDP
 * PAResponse, and the seed) is also kept there, apart from the 500-entry
 * feed, so seeded and live traffic are counted the same way and older
 * decisions do not age out.
 * A request is identified by pa.requestId; its last entry is its status.
 * Forced debug denials (pa.forced) are not decisions and are left out.
 *
 * Server-only.
 */

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function summarize(requests) {
  const n = requests.length;
  const count = (d) => requests.filter((r) => r.determination === d).length;
  const approved = count('approved');
  const denied = count('denied');
  const pending = count('pended');
  const decided = requests.filter((r) => r.determination !== 'pended' && r.receivedAt && r.decidedAt);
  const secs = decided.map((r) => (Date.parse(r.decidedAt) - Date.parse(r.receivedAt)) / 1000).filter((x) => x >= 0);
  const pct = (x) => (n ? Math.round((x / n) * 1000) / 10 : 0);
  return {
    requests: n,
    approved,
    denied,
    pending,
    approvedPct: pct(approved),
    deniedPct: pct(denied),
    // The sandbox has no appeal flow, so these stay at zero. They are
    // reported so the shape matches the required metric set.
    appeals: 0,
    overturned: 0,
    deniedAfterAppeal: 0,
    avgDecisionSeconds: secs.length ? Math.round((secs.reduce((a, b) => a + b, 0) / secs.length) * 10) / 10 : null,
    medianDecisionSeconds: secs.length ? Math.round(median(secs) * 10) / 10 : null
  };
}

export function paMetrics() {
  // Oldest first, so the last event per request wins.
  // Forced debug denials and drug PAS requests with no DTR answers are not
  // decisions by the shared model (the access APIs leave them out too).
  const events = getPaEvents().filter((e) => !e.forced && !e.noAnswers);
  const byId = new Map();
  for (const e of events) {
    const prev = byId.get(e.requestId);
    byId.set(e.requestId, {
      ...(prev || {}),
      ...e,
      receivedAt: e.receivedAt || prev?.receivedAt || null,
      decidedAt: e.determination === 'pended' ? null : e.decidedAt || e.timestamp
    });
  }
  const all = [...byId.values()];
  const items = all.filter((r) => r.category === 'item');
  // MA plans report Part B drugs only (the medical benefit). Part D drugs
  // for MA-PD plans are left out of every drug aggregate, not only byPlan.
  const isMaPlan = (r) => String(r.planType || '').startsWith('MA-');
  const drugs = all.filter((r) => r.category === 'drug' && !(isMaPlan(r) && r.benefit !== 'medical'));

  // Drug metrics by plan. MA plans report Part B drugs only (the medical
  // benefit); Part D drugs for MA-PD plans are excluded.
  // MA-PPO is always listed, so its Part B note shows before any MA drug PA.
  // Every configured plan is listed (MA-PPO included), so each plan shows a
  // zero row and the MA Part B note before any drug PA, plus any other plan
  // seen in the events.
  const configuredPlans = (getDb().plans || []).map((p) => p.plan_type).filter(Boolean);
  const drugPlans = [...new Set(['MA-PPO', ...configuredPlans, ...drugs.map((r) => String(r.planType || 'unknown'))])].sort();
  const drugsByPlan = drugPlans.map((planType) => {
    const scoped = drugs.filter((r) => String(r.planType || 'unknown') === planType);
    const isMa = planType.startsWith('MA-');
    return {
      planType,
      note: isMa ? 'Part B drugs only. Part D drugs for MA-PD plans are excluded.' : null,
      ...summarize(scoped)
    };
  });

  // Drugs that require PA: J-code rules on the ingested grids, plus the
  // sandbox's drug catalog.
  const rules = getDb().rules || [];
  const jCodes = rules.filter((r) => /^J\d{4}$/.test(r.service_code || '') && r.pa_needed === 'auth-needed');
  const bySource = {};
  for (const r of jCodes) bySource[r.source_label || 'unknown'] = (bySource[r.source_label || 'unknown'] || 0) + 1;

  return {
    generatedAt: new Date().toISOString(),
    medicalItems: summarize(items),
    drugs: {
      all: summarize(drugs),
      medicalBenefit: summarize(drugs.filter((r) => r.benefit === 'medical')),
      pharmacyBenefit: summarize(drugs.filter((r) => r.benefit === 'pharmacy')),
      byPlan: drugsByPlan
    },
    drugsRequiringPa: {
      gridJCodeRules: jCodes.length,
      gridJCodeRulesBySource: bySource,
      catalog: Object.values(DRUG_CATALOG).map((d) => ({ key: d.key, name: d.name }))
    },
    notes: [
      'Counts come from PA decisions in the in-memory transaction log, seeded and live. They reset when the demo resets or the container restarts.',
      'Decision times are seconds because the sandbox decides immediately or after an 8-second demo review window.',
      'The sandbox has no appeal flow, so appeals, overturns, and denials after appeal are zero.'
    ]
  };
}

export function usageMetrics() {
  return getApiUsage().map(({ api, counts }) => {
    const considered = counts.success + counts.authFailure + counts.serverError;
    return {
      api,
      ...counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      errorRatePct: considered ? Math.round(((counts.authFailure + counts.serverError) / considered) * 1000) / 10 : 0
    };
  });
}
