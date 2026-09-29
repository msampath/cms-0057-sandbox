'use client';
import { IG_REGISTRY, PRIOR_VERSION_EXPIRY, CMS_0062_P_DATES } from '@/lib/fhir';

/**
 * Standards and dates under CMS-0062-P (proposed). Reads IG_REGISTRY so
 * the table, the CapabilityStatement, and the sunset markers stay in step.
 */

function fmtDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
  });
}

// Numeric compare of dotted versions: -1, 0, 1.
function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

function sunsetMarker(ig) {
  if (ig.current?.expired) {
    return { tone: 'red', text: `${ig.current.expired.version} expired ${fmtDate(ig.current.expired.on)}` };
  }
  if (ig.proposed && ig.current) {
    return { tone: 'amber', text: `${ig.current.version} would expire ${fmtDate(PRIOR_VERSION_EXPIRY)}` };
  }
  if (ig.proposed) return { tone: 'blue', text: 'New to 170.215' };
  return { tone: 'gray', text: 'No change proposed' };
}

function sandboxNote(ig) {
  if (!ig.sandbox) return { tone: 'gray', text: 'not built to a version' };
  if (ig.current?.expired?.version === ig.sandbox) return { tone: 'red', text: 'expired version' };
  if (ig.current && cmpVersion(ig.sandbox, ig.current.version) < 0) {
    return { tone: 'amber', text: `behind ${ig.current.version}` };
  }
  return null;
}

const TONE = {
  red: 'text-red-300 bg-red-950/40 border-red-800',
  amber: 'text-amber-300 bg-amber-950/40 border-amber-800',
  blue: 'text-sky-300 bg-sky-950/40 border-sky-800',
  gray: 'text-gray-400 bg-gray-900 border-gray-700'
};

export default function StandardsPanel() {
  return (
    <div className="space-y-6 text-sm">
      <div className="text-xs text-amber-200 bg-amber-950/30 border border-amber-800 rounded px-3 py-2">
        CMS-0062-P is a proposed rule (91 FR 19890, April 14, 2026). Versions and dates below follow the proposed text and may change in the final rule.
      </div>

      <section>
        <h3 className="text-gray-300 font-bold mb-1">Implementation guide versions (45 CFR 170.215)</h3>
        <p className="text-xs text-gray-500 mb-2">
          Today payers use the versions adopted in 170.215. CMS-0062-P proposes that payers may use any unexpired version, and that the versions it replaces expire on {fmtDate(PRIOR_VERSION_EXPIRY)}. The sunset marker shows what a defined sunset window looks like for each guide.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border border-gray-700">
            <thead className="bg-gray-800 text-gray-400">
              <tr>
                <th className="text-left px-2 py-1.5 font-normal">Guide</th>
                <th className="text-left px-2 py-1.5 font-normal">Sandbox</th>
                <th className="text-left px-2 py-1.5 font-normal">170.215 today</th>
                <th className="text-left px-2 py-1.5 font-normal">CMS-0062-P proposes</th>
                <th className="text-left px-2 py-1.5 font-normal">Sunset marker</th>
              </tr>
            </thead>
            <tbody>
              {IG_REGISTRY.map((ig) => {
                const marker = sunsetMarker(ig);
                const note = sandboxNote(ig);
                return (
                  <tr key={ig.key} className="border-t border-gray-800">
                    <td className="px-2 py-1.5 text-gray-200">{ig.name}</td>
                    <td className="px-2 py-1.5">
                      <code className="text-gray-200">{ig.sandbox || '-'}</code>
                      {note && (
                        <span className={`ml-2 px-1.5 py-0.5 rounded border ${TONE[note.tone]}`}>{note.text}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-gray-300">
                      {ig.current ? (
                        <>
                          <code>{ig.current.version}</code>{' '}
                          <span className="text-gray-500">{ig.current.cfr}</span>
                        </>
                      ) : (
                        <span className="text-gray-500">not listed</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-gray-300">
                      {ig.proposed ? (
                        <>
                          <code>{ig.proposed.version}</code>
                          {ig.proposed.cfr && <span className="text-gray-500"> {ig.proposed.cfr}</span>}
                        </>
                      ) : (
                        <span className="text-gray-500">-</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <span className={`px-1.5 py-0.5 rounded border ${TONE[marker.tone]}`}>{marker.text}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Position: require a version only once it is balloted and stable, with lead time before the compliance date. Keep the sunset window so a payer cannot stay on the oldest version indefinitely.
        </p>
      </section>

      <section>
        <h3 className="text-gray-300 font-bold mb-2">Proposed compliance dates</h3>
        <ul className="space-y-2">
          {CMS_0062_P_DATES.map((d) => (
            <li key={d.when} className="flex flex-col md:flex-row gap-1 md:gap-3 border-l-2 border-emerald-700 pl-3">
              <span className="text-emerald-300 shrink-0 md:w-72">{d.when}</span>
              <span className="text-gray-300">{d.what}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
