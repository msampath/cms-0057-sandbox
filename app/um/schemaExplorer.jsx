'use client';
import { useState } from 'react';
import useSWR from 'swr';

const fetcher = (url) => fetch(url).then((r) => r.json());

/**
 * Schema Explorer — surfaces the non-rule sections of the CRD data model:
 * payer, plans, network_tiers, service_categories, questionnaires,
 * gold_card_programs. The rules index is large and lives in its own panel.
 */
export default function SchemaExplorer() {
  const { data, isLoading } = useSWR('/api/schema', fetcher, { refreshInterval: 5000 });
  const [tab, setTab] = useState('payer');

  if (isLoading || !data) {
    return (
      <div className="bg-gray-800 p-4 rounded border border-gray-700 mb-6 text-xs text-gray-400">
        loading schema…
      </div>
    );
  }

  const tabs = [
    { id: 'payer',              label: 'Payer',              count: 1 },
    { id: 'plans',              label: 'Plans',              count: (data.plans || []).length },
    { id: 'network_tiers',      label: 'Network Tiers',      count: (data.network_tiers || []).length },
    { id: 'service_categories', label: 'Service Categories', count: (data.service_categories || []).length },
    { id: 'questionnaires',     label: 'Questionnaires',     count: (data.questionnaires || []).length },
    { id: 'gold_card_programs', label: 'Gold Card Programs', count: (data.gold_card_programs || []).length }
  ];

  return (
    <div className="bg-gray-800 p-4 rounded border border-gray-700 mb-6">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="text-lg font-bold text-blue-400">Schema Explorer</h2>
        <div className="text-[10px] text-gray-500">CRD data model · 7 sections (rules: see panel above)</div>
      </div>
      <div className="flex flex-wrap gap-1 mb-3">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`text-xs px-3 py-1.5 rounded ${tab === t.id ? 'bg-blue-700 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-700'}`}
          >
            {t.label} <span className="text-gray-400">({t.count})</span>
          </button>
        ))}
      </div>
      <div className="bg-gray-900 border border-gray-700 rounded p-3 overflow-auto" style={{ maxHeight: 360 }}>
        {tab === 'payer' && <Payer payer={data.payer} />}
        {tab === 'plans' && <Plans plans={data.plans} />}
        {tab === 'network_tiers' && <NetworkTiers tiers={data.network_tiers} />}
        {tab === 'service_categories' && <ServiceCategories cats={data.service_categories} />}
        {tab === 'questionnaires' && <Questionnaires qs={data.questionnaires} />}
        {tab === 'gold_card_programs' && <GoldCards programs={data.gold_card_programs} />}
      </div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div className="mb-1">
      <span className="text-[10px] uppercase tracking-wide text-gray-500">{label}: </span>
      <span className="text-gray-200 text-xs">{value || <em>—</em>}</span>
    </div>
  );
}

function Payer({ payer }) {
  if (!payer) return <em className="text-gray-500">no payer configured</em>;
  return (
    <div className="text-xs">
      <Field label="id" value={<code>{payer.id}</code>} />
      <Field label="name" value={payer.name} />
      <Field label="contact" value={<span>{payer.contact?.name} · {payer.contact?.phone} · <a href={payer.contact?.url} className="text-blue-400 underline" target="_blank" rel="noreferrer">{payer.contact?.url}</a></span>} />
    </div>
  );
}

function Plans({ plans }) {
  if (!plans?.length) return <em className="text-gray-500">no plans defined</em>;
  return (
    <div className="space-y-3">
      {plans.map((p) => (
        <div key={p.plan_type} className="bg-gray-800 p-2 rounded border border-gray-700 text-xs">
          <div className="flex items-center justify-between mb-1">
            <code className="text-gray-100 font-bold">{p.plan_type}</code>
            <span className={`text-[10px] px-2 py-0.5 rounded ${p.requires_pa_by_default ? 'bg-amber-900 text-amber-200' : 'bg-emerald-900 text-emerald-200'}`}>
              {p.requires_pa_by_default ? 'PA-by-default' : 'PA only on listed codes'}
            </span>
          </div>
          <Field label="name" value={p.name} />
          <Field label="benefit_period" value={<code>{p.benefit_period}</code>} />
          <Field label="oon_rule" value={p.oon_rule} />
          <Field label="blanket_exemptions" value={<span>{p.blanket_exemptions?.join(' · ') || '—'}</span>} />
          {p.contact && <Field label="contact" value={`${p.contact.name} · ${p.contact.phone}`} />}
        </div>
      ))}
    </div>
  );
}

function NetworkTiers({ tiers }) {
  if (!tiers?.length) return <em className="text-gray-500">no tiers defined</em>;
  return (
    <div className="space-y-3">
      {tiers.map((t) => (
        <div key={t.tier_code} className="bg-gray-800 p-2 rounded border border-gray-700 text-xs">
          <div className="flex items-center justify-between mb-1">
            <span><code className="text-gray-100">{t.tier_code}</code> · <strong className="text-gray-200">{t.tier_name}</strong></span>
            <span className="text-[10px] text-gray-500">
              {(t.providers?.length || 0)} NPIs · {(t.tins?.length || 0)} TINs · {(t.pa_exemptions?.length || 0)} exempted codes
            </span>
          </div>
          <Field label="description" value={t.description} />
          <Field label="applies_to_plans" value={t.applies_to_plans?.join(', ') || 'all'} />
        </div>
      ))}
    </div>
  );
}

function ServiceCategories({ cats }) {
  if (!cats?.length) return <em className="text-gray-500">no categories defined</em>;
  return (
    <div className="space-y-3">
      {cats.map((c) => (
        <div key={c.category_id} className="bg-gray-800 p-2 rounded border border-gray-700 text-xs">
          <div className="flex items-center justify-between mb-1">
            <code className="text-gray-100">{c.category_id}</code>
            <span className="text-[10px] text-gray-500">{c.codes?.length || 0} codes</span>
          </div>
          <Field label="name" value={c.category_name} />
          <Field label="description" value={c.description} />
          <Field label="default_rule" value={<code>covered={c.default_rule?.covered} · pa={c.default_rule?.pa_needed}</code>} />
        </div>
      ))}
    </div>
  );
}

function Questionnaires({ qs }) {
  if (!qs?.length) return <em className="text-gray-500">no Questionnaires registered</em>;
  return (
    <table className="w-full text-xs">
      <thead className="text-gray-400">
        <tr><th className="text-left px-1 py-1 font-normal">id</th>
            <th className="text-left px-1 py-1 font-normal">topic</th>
            <th className="text-left px-1 py-1 font-normal">version</th>
            <th className="text-left px-1 py-1 font-normal">canonical url</th></tr>
      </thead>
      <tbody>
        {qs.map((q) => (
          <tr key={q.id} className="border-t border-gray-800">
            <td className="px-1 py-1"><code className="text-gray-100">{q.id}</code></td>
            <td className="px-1 py-1 text-gray-300">{q.topic}</td>
            <td className="px-1 py-1 text-gray-400">{q.version}</td>
            <td className="px-1 py-1 text-[10px] text-blue-300 break-all">{q.canonical_url}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GoldCards({ programs }) {
  if (!programs?.length) return <em className="text-gray-500">no gold-card programs defined</em>;
  return (
    <div className="space-y-3">
      {programs.map((g, i) => (
        <div key={i} className="bg-gray-800 p-2 rounded border border-emerald-700 text-xs">
          <div className="flex items-center justify-between mb-1">
            <strong className="text-emerald-200">{g.program_name}</strong>
            <span className="text-[10px] bg-emerald-900 text-emerald-200 px-2 py-0.5 rounded">
              {g.exemption_type}
            </span>
          </div>
          <Field label="eligibility" value={g.eligibility} />
          <Field label="provider_scope" value={g.provider_scope} />
          <Field label="code_scope" value={<span>{g.code_scope?.length || 0} codes: {g.code_scope?.slice(0, 6).join(', ')}{(g.code_scope?.length || 0) > 6 ? '…' : ''}</span>} />
          <Field label="enrolled providers" value={`${g.providers?.length || 0} NPI${(g.providers?.length || 0) === 1 ? '' : 's'}`} />
          <Field label="effective_date" value={<code>{g.effective_date}</code>} />
        </div>
      ))}
    </div>
  );
}
