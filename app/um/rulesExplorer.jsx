'use client';
import { useMemo, useState } from 'react';
import useSWR from 'swr';

const fetcher = (url) => fetch(url).then((r) => r.json());

/**
 * Rules Explorer.
 *
 * Lets the reviewer try out service codes (or categories) against the
 * committed rules index and inspect the rule that fires:
 *   - PA required? indicator
 *   - Routing vendor (managed_by)
 *   - Bound Questionnaire / CQL Library
 *   - Documentation requirements
 *   - Provenance (which uploaded PDF the rule came from, if any)
 *   - Effective date
 */
export default function RulesExplorer() {
  const { data, isLoading } = useSWR('/api/rules', fetcher, { refreshInterval: 2000 });
  const rules = data?.rules || [];

  const [query, setQuery] = useState('');
  const [onlyPa, setOnlyPa] = useState(false);
  const [selected, setSelected] = useState(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rules.filter((r) => {
      if (onlyPa && r.pa_needed !== 'auth-needed') return false;
      if (!q) return true;
      return (
        (r.service_code || '').toLowerCase().includes(q) ||
        (r.service_category || '').toLowerCase().includes(q) ||
        (r.description || '').toLowerCase().includes(q) ||
        (r.managed_by || '').toLowerCase().includes(q) ||
        (r.source_file || '').toLowerCase().includes(q)
      );
    });
  }, [rules, query, onlyPa]);

  const exactMatch = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return (
      rules.find(
        (r) =>
          (r.match_type === 'code' && (r.service_code || '').toLowerCase() === q) ||
          (r.match_type === 'category' && (r.service_category || '').toLowerCase() === q)
      ) || null
    );
  }, [rules, query]);

  const detail = selected || exactMatch;

  return (
    <div className="bg-gray-800 p-4 rounded border border-gray-700 mb-6">
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <h2 className="text-lg font-bold text-blue-400">Rules Explorer</h2>
        <div className="text-xs text-gray-400">
          {isLoading
            ? 'loading…'
            : `${rules.length} rule${rules.length === 1 ? '' : 's'} in active CRD memory`}
        </div>
      </div>

      <div className="flex gap-2 items-center mb-3 flex-wrap">
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(null);
          }}
          placeholder="Try a code (70553, J9035, 99214) or category text…"
          className="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 flex-1 min-w-[260px] font-mono"
        />
        <label className="flex items-center gap-2 text-xs text-gray-300">
          <input
            type="checkbox"
            checked={onlyPa}
            onChange={(e) => setOnlyPa(e.target.checked)}
          />
          Only PA-required
        </label>
        {(query || onlyPa) && (
          <button
            onClick={() => {
              setQuery('');
              setOnlyPa(false);
              setSelected(null);
            }}
            className="text-xs text-gray-400 hover:text-gray-200 underline"
          >
            clear
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
        <div className="lg:col-span-3 bg-gray-900 border border-gray-700 rounded overflow-auto" style={{ maxHeight: 340 }}>
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-800 text-gray-400">
              <tr>
                <th className="text-left px-2 py-1 font-normal">Code / Category</th>
                <th className="text-left px-2 py-1 font-normal">Description</th>
                <th className="text-left px-2 py-1 font-normal">PA</th>
                <th className="text-left px-2 py-1 font-normal">Vendor</th>
                <th className="text-left px-2 py-1 font-normal">Source</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-2 py-4 text-center text-gray-500">
                    {query
                      ? <>No rule matches &ldquo;{query}&rdquo;. <span className="text-amber-300">The CRD engine would return a fallback warning for this code.</span></>
                      : 'No rules in CRD memory yet — upload a grid to commit some.'}
                  </td>
                </tr>
              ) : (
                filtered.map((r, i) => {
                  const id = r.service_code || r.service_category;
                  const isSelected = detail === r;
                  return (
                    <tr
                      key={i}
                      onClick={() => setSelected(r)}
                      className={`cursor-pointer ${isSelected ? 'bg-blue-900/40' : 'hover:bg-gray-800/60'}`}
                    >
                      <td className="px-2 py-1 align-top text-gray-100 font-mono">
                        {r.match_type === 'category' ? (
                          <span title={r.service_category}>{(r.service_category || '').slice(0, 26)}…</span>
                        ) : (
                          r.service_code
                        )}
                      </td>
                      <td className="px-2 py-1 align-top text-gray-300">{r.description}</td>
                      <td className="px-2 py-1 align-top">
                        <PaBadge value={r.pa_needed} />
                      </td>
                      <td className="px-2 py-1 align-top text-gray-200">{r.managed_by}</td>
                      <td className="px-2 py-1 align-top text-gray-400 text-[10px]">
                        {r.source_file ? <code>{r.source_file}</code> : <em>seed</em>}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="lg:col-span-2">
          <RuleDetail rule={detail} />
        </div>
      </div>
    </div>
  );
}

function PaBadge({ value }) {
  if (value === 'no-auth') {
    return <span className="bg-emerald-900 text-emerald-200 px-2 py-0.5 rounded text-[10px] uppercase">No PA</span>;
  }
  return <span className="bg-amber-900 text-amber-200 px-2 py-0.5 rounded text-[10px] uppercase">Auth needed</span>;
}

function RuleDetail({ rule }) {
  if (!rule) {
    return (
      <div className="bg-gray-900 border border-gray-700 rounded p-3 text-xs text-gray-500 h-full">
        Type a code above (e.g. <code className="text-gray-300">70553</code>) or click a row to inspect the
        rule the CRD engine would fire — PA status, routing vendor,
        bound Questionnaire/CQL, and the source grid.
      </div>
    );
  }
  const id = rule.match_type === 'category' ? rule.service_category : rule.service_code;
  const paLabel = rule.pa_needed === 'no-auth' ? 'No prior authorization required' : 'Prior authorization required';
  return (
    <div className="bg-gray-900 border border-gray-700 rounded p-3 text-xs">
      <div className="text-[10px] uppercase tracking-widest text-blue-300 mb-1">
        {rule.match_type === 'category' ? 'Category-match rule' : 'Code-match rule'}
      </div>
      <div className="text-lg font-mono text-white mb-1 break-all">{id}</div>
      <div className="text-gray-300 mb-3">{rule.description}</div>

      <div className={`rounded p-2 mb-3 border ${rule.pa_needed === 'no-auth' ? 'bg-emerald-950/40 border-emerald-700' : 'bg-amber-950/40 border-amber-700'}`}>
        <div className={`text-sm font-bold ${rule.pa_needed === 'no-auth' ? 'text-emerald-200' : 'text-amber-200'}`}>
          {paLabel}
        </div>
        <div className="text-[11px] text-gray-300 mt-1">
          Routed to <strong className="text-white">{rule.managed_by}</strong>
        </div>
      </div>

      {rule.pa_needed === 'auth-needed' && (
        <div className="space-y-2 mb-3">
          <Field label="Bound Questionnaire" value={rule.questionnaire_id || <em>—</em>} mono />
          <Field label="Bound CQL Library" value={rule.cql_library_id || <em>none</em>} mono />
          <Field
            label="Documentation requirements"
            value={rule.documentation_requirements || <em>—</em>}
          />
        </div>
      )}

      {(rule.covered || rule.condition || rule.info_needed || rule.network_dependency || rule.expiry_days) && (
        <div className="space-y-2 mb-3 border-t border-gray-700 pt-2">
          <div className="text-[10px] uppercase tracking-widest text-cyan-300">Coverage detail</div>
          {rule.covered && <Field label="covered" value={<code>{rule.covered}</code>} mono />}
          {rule.condition && (
            <Field label={`Condition (${rule.condition.type})`} value={<code className="text-[10px]">{JSON.stringify(rule.condition.params || {})}</code>} />
          )}
          {rule.info_needed?.length > 0 && (
            <Field label="info_needed" value={rule.info_needed.join(' · ')} />
          )}
          {rule.reason && (
            <Field label={`Reason (${rule.reason.code})`} value={rule.reason.text} />
          )}
          {rule.network_dependency && (
            <Field label="network_dependency" value={<code>{rule.network_dependency}</code>} mono />
          )}
          {rule.expiry_days && (
            <Field label="expiry_days" value={<code>{rule.expiry_days}</code>} mono />
          )}
        </div>
      )}

      {rule.formulary && (
        <div className="space-y-2 mb-3 border-t border-gray-700 pt-2">
          <div className="text-[10px] uppercase tracking-widest text-purple-300">Formulary (medication metadata)</div>
          <Field label="tier" value={<code>{rule.formulary.tier}</code>} mono />
          <Field label="specialty" value={rule.formulary.specialty ? 'yes' : 'no'} />
          {rule.formulary.quantity_limit && (
            <Field
              label="quantity_limit"
              value={<code className="text-[10px]">{`max ${rule.formulary.quantity_limit.max} ${rule.formulary.quantity_limit.unit} / ${rule.formulary.quantity_limit.days_supply}d`}</code>}
            />
          )}
          {rule.formulary.site_of_care && <Field label="site_of_care" value={<code>{rule.formulary.site_of_care}</code>} mono />}
          {rule.formulary.preferred_alternatives?.length > 0 && (
            <Field label="preferred_alternatives" value={rule.formulary.preferred_alternatives.join(' · ')} />
          )}
        </div>
      )}

      {rule.contact && (
        <div className="space-y-1 mb-3 border-t border-gray-700 pt-2">
          <div className="text-[10px] uppercase tracking-widest text-orange-300">Service-specific contact</div>
          <Field label="name" value={rule.contact.name} />
          {rule.contact.phone && <Field label="phone" value={rule.contact.phone} />}
          {rule.contact.url && <Field label="url" value={<a href={rule.contact.url} className="text-blue-400 underline" target="_blank" rel="noreferrer">{rule.contact.url}</a>} />}
          {rule.contact.hours && <Field label="hours" value={rule.contact.hours} />}
        </div>
      )}

      <div className="border-t border-gray-700 pt-2 mt-2">
        <div className="text-[10px] uppercase tracking-widest text-fuchsia-300 mb-1">
          Provenance
        </div>
        <Field
          label="Source grid"
          value={rule.source_file ? <code>{rule.source_file}</code> : <em>seed data (no uploaded grid)</em>}
        />
        {rule.also_in?.length > 0 && (
          <Field
            label="Also present in"
            value={rule.also_in.map((f, i) => <code key={i} className="mr-2">{f}</code>)}
          />
        )}
        <Field label="Effective date" value={rule.effective_date || <em>—</em>} mono />
      </div>
    </div>
  );
}

function Field({ label, value, mono }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-gray-100 ${mono ? 'font-mono text-[11px]' : 'text-xs'} break-words`}>
        {value}
      </div>
    </div>
  );
}
