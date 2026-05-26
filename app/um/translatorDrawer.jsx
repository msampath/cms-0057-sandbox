'use client';
import { useState } from 'react';

/**
 * FHIR ↔ X12 translation drawer.
 *
 * Renders the "Unaltered FHIR Bundle" strategy visually:
 *   - Left:   the FHIR Bundle as it was submitted, byte-for-byte.
 *   - Middle: the field-to-segment mapping table (hover to highlight).
 *   - Right:  the X12 278 segments — a parallel projection of the Bundle.
 *
 * The Bundle is the source of truth. The X12 is generated alongside for
 * the legacy adjudication engine. Neither was reconstructed from the other.
 */
export default function TranslatorDrawer({ payload }) {
  const [hovered, setHovered] = useState(null);

  if (!payload || payload.kind !== 'fhir-x12-translation') return null;

  const { bundle, x12, mappings, vendor, note } = payload;
  const segments = x12.split('~\n').map((s, i, arr) => (i < arr.length - 1 ? s + '~' : s.replace(/~$/, '~')));

  return (
    <div className="bg-slate-950 border border-slate-700 rounded p-3 mt-2 text-[12px] leading-snug">
      <div className="bg-emerald-950/40 border-l-4 border-emerald-500 px-3 py-2 mb-3 text-emerald-200 text-[11px]">
        <strong className="text-emerald-100">Unaltered FHIR Bundle strategy.</strong>{' '}
        {note || 'Bundle preserved as the source of truth; X12 278 is a parallel projection for the legacy adjudication engine.'}
        {vendor && (
          <> Routed to <code className="text-emerald-100">{vendor}</code>.</>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        {/* FHIR Bundle */}
        <div className="lg:col-span-4">
          <div className="text-[10px] uppercase tracking-widest text-blue-300 mb-1">
            FHIR Bundle (preserved unaltered)
          </div>
          <pre className="bg-black border border-slate-800 rounded p-2 overflow-auto max-h-[420px] text-blue-200 text-[10px] leading-tight">
            <code>{JSON.stringify(bundle, null, 2)}</code>
          </pre>
        </div>

        {/* Mapping table */}
        <div className="lg:col-span-4">
          <div className="text-[10px] uppercase tracking-widest text-fuchsia-300 mb-1">
            Field-to-segment mapping ({mappings.length})
          </div>
          <div className="bg-black border border-slate-800 rounded overflow-auto max-h-[420px]">
            <table className="w-full text-[10px]">
              <thead className="sticky top-0 bg-slate-900 text-slate-400">
                <tr>
                  <th className="text-left px-2 py-1 font-normal">FHIR path</th>
                  <th className="text-left px-2 py-1 font-normal">→ Segment</th>
                </tr>
              </thead>
              <tbody>
                {mappings.map((m, i) => (
                  <tr
                    key={i}
                    onMouseEnter={() => setHovered(i)}
                    onMouseLeave={() => setHovered(null)}
                    className={`cursor-default ${hovered === i ? 'bg-fuchsia-900/40' : 'hover:bg-slate-800/60'}`}
                  >
                    <td className="px-2 py-1 align-top text-blue-300 break-all">
                      <code>{m.fhirPath}</code>
                    </td>
                    <td className="px-2 py-1 align-top text-cyan-300 break-all">
                      <div className="font-semibold text-[9px] uppercase tracking-wide text-slate-400">
                        {m.label}
                      </div>
                      <code>{m.value || '—'}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* X12 segments */}
        <div className="lg:col-span-4">
          <div className="text-[10px] uppercase tracking-widest text-cyan-300 mb-1">
            X12 278 — parallel projection
          </div>
          <pre className="bg-black border border-slate-800 rounded p-2 overflow-auto max-h-[420px] text-[10px] leading-tight">
            <code>
              {segments.map((seg, i) => (
                <div
                  key={i}
                  onMouseEnter={() => setHovered(i)}
                  onMouseLeave={() => setHovered(null)}
                  className={`px-1 -mx-1 ${
                    hovered === i ? 'bg-fuchsia-900/40 text-fuchsia-100' : 'text-cyan-200'
                  }`}
                >
                  {seg}
                </div>
              ))}
            </code>
          </pre>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact toggle that wraps the drawer. Used inside log lines.
 */
export function TranslatorToggle({ payload }) {
  const [open, setOpen] = useState(false);
  if (!payload || payload.kind !== 'fhir-x12-translation') return null;
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-200 px-2 py-0.5 rounded border border-slate-700"
      >
        {open ? '▼ Hide FHIR ↔ X12 translation' : '▶ Show FHIR ↔ X12 translation'}{' '}
        <span className="text-slate-500">({payload.mappings?.length || 0} mappings)</span>
      </button>
      {open && <TranslatorDrawer payload={payload} />}
    </div>
  );
}
