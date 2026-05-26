import Link from 'next/link';

export default function Landing() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-800 text-slate-100 flex items-center justify-center p-8">
      <div className="max-w-2xl w-full">
        <div className="text-xs uppercase tracking-widest text-emerald-400 mb-2">
          CMS-0057-F Dual-Window Simulator
        </div>
        <h1 className="text-4xl font-bold mb-3">Interoperability Sandbox</h1>
        <p className="text-slate-300 mb-8">
          Two surfaces, one workflow. Start on the payer side to ingest PA
          grids, commit rules to the CRD engine, then move to the provider
          side to sign an order and watch the X12 278 translation stream
          back into the payer&apos;s live feed.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Link
            href="/um"
            className="block bg-emerald-700 hover:bg-emerald-600 rounded-lg p-6 shadow ring-2 ring-emerald-400"
          >
            <div className="text-xs uppercase tracking-widest text-emerald-200 mb-1">
              Step 1 &middot; Payer
            </div>
            <div className="text-2xl font-bold mb-1">UM Dashboard</div>
            <div className="text-sm text-emerald-100">
              Upload PA grids, review extraction quality gate, commit rules
              to the CRD engine, then keep this window open for the live
              EDI/FHIR feed.
            </div>
          </Link>
          <Link
            href="/ehr"
            className="block bg-blue-700 hover:bg-blue-600 rounded-lg p-6 shadow"
          >
            <div className="text-xs uppercase tracking-widest text-blue-200 mb-1">
              Step 2 &middot; Provider
            </div>
            <div className="text-2xl font-bold mb-1">EHR Workspace</div>
            <div className="text-sm text-blue-100">
              Sign an order against the committed rules. CDS Hooks 2.0 card,
              DTR SMART surface, PAS Bundle submission.
            </div>
          </Link>
        </div>
        <div className="mt-4 text-xs text-slate-400">
          Tip: open both windows side by side. The simulator ships with seed
          rules so Step 2 works even if you skip Step 1, but the full demo
          story starts at the payer.
        </div>
      </div>
    </main>
  );
}
