'use client';
import { useState } from 'react';
import useSWR from 'swr';

const PATIENTS = [
  { id: 'pat-8849-jane-doe',        name: 'Jane Doe',        dob: '1972-04-14', planType: 'COMM-PPO' },
  { id: 'pat-7712-robert-chen',     name: 'Robert Chen',     dob: '1955-09-22', planType: 'MA-PPO'   },
  { id: 'pat-3301-dorothy-hayes',   name: 'Dorothy Hayes',   dob: '1948-03-07', planType: 'COMM-PPO' },
  { id: 'pat-6614-marcus-johnson',  name: 'Marcus Johnson',  dob: '2014-11-19', planType: 'COMM-HMO' },
];

const fetcher = (url) => fetch(url).then((r) => r.json());

export default function PatientAccess() {
  const [selectedId, setSelectedId] = useState('pat-8849-jane-doe');

  const { data, isLoading } = useSWR(
    `/api/patient-access?patientId=${selectedId}`,
    fetcher,
    { refreshInterval: 3000 }
  );

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 font-mono p-8">
      {/* Header */}
      <div className="border-b border-gray-700 pb-4 mb-6 flex justify-between items-center flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-green-400">Patient Access Portal</h1>
          <p className="text-xs text-gray-400 mt-1">
            45 CFR 156.221(a) — Da Vinci PDex IG · US Core STU 3.1.1 · SMART on FHIR v2 (patient launch)
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <a href="/ehr" className="text-xs text-gray-400 hover:text-gray-200 underline">EHR surface</a>
          <span className="text-gray-600">·</span>
          <a href="/um" className="text-xs text-gray-400 hover:text-gray-200 underline">Payer UM</a>
          <span className="bg-green-900 text-green-300 text-xs px-2 py-1 rounded ml-2">SYSTEM: ONLINE</span>
        </div>
      </div>

      {/* SMART auth notice */}
      <div className="bg-indigo-950/50 border border-indigo-700 rounded p-3 text-xs text-indigo-200 mb-6">
        <span className="font-bold text-indigo-300">SMART on FHIR v2 — patient launch (simulated)</span>
        <span className="text-indigo-400 ml-2">
          Production: patient authenticates with the payer identity portal and authorizes a third-party app
          (e.g., Apple Health, CommonHealth) with scopes{' '}
          <code className="bg-indigo-900 px-1 rounded">patient/Patient.read patient/Coverage.read patient/ExplanationOfBenefit.read patient/ClaimResponse.read</code>.
          Demo: patient selected from the dropdown below.
        </span>
      </div>

      {/* Patient selector */}
      <div className="bg-gray-800 rounded border border-gray-700 p-4 mb-6">
        <label className="text-xs text-gray-400 block mb-2">Select patient (simulates payer portal login)</label>
        <div className="flex gap-2 flex-wrap">
          {PATIENTS.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              className={`px-3 py-1.5 rounded text-sm border transition-colors ${
                selectedId === p.id
                  ? 'bg-blue-700 border-blue-500 text-white font-semibold'
                  : 'bg-gray-900 border-gray-600 text-gray-300 hover:border-gray-400'
              }`}
            >
              {p.name}
              <span className="ml-1.5 text-xs opacity-70">{p.planType}</span>
            </button>
          ))}
        </div>
      </div>

      {isLoading && <div className="text-sm text-gray-400">Loading member record…</div>}

      {data && !isLoading && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column: coverage card */}
          <div className="lg:col-span-1 space-y-4">
            <CoverageCard coverage={data.coverage} patient={data.patient} />
            <ScopesCard scopes={data.smartScopes} note={data.smartNote} />
          </div>

          {/* Right column: PA history */}
          <div className="lg:col-span-2">
            <PAHistory events={data.events} />
          </div>
        </div>
      )}
    </div>
  );
}

function CoverageCard({ coverage, patient }) {
  if (!coverage) return null;
  return (
    <div className="bg-gray-800 border border-gray-700 rounded p-4">
      <div className="text-xs uppercase tracking-wide text-blue-300 mb-3">Current coverage</div>
      <div className="text-lg font-bold text-gray-100 mb-1">{patient?.name?.[0]?.text || '—'}</div>
      <div className="text-xs text-gray-400 mb-3">
        DOB {patient?.birthDate} · {patient?.gender}
      </div>
      <div className="space-y-1.5 text-sm">
        <Row label="Plan" value={coverage.planName} />
        <Row label="Type" value={coverage.planType} />
        <Row label="Payer" value={coverage.payer} />
        <Row label="Member ID" value={coverage.subscriberId} />
        <Row label="Coverage ID" value={coverage.id} mono />
        <Row label="Benefit year" value={coverage.benefitYear} />
        <Row label="Status" value={<span className="text-green-300 font-semibold">Active</span>} />
      </div>
    </div>
  );
}

function ScopesCard({ scopes, note }) {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded p-4">
      <div className="text-xs uppercase tracking-wide text-indigo-300 mb-2">SMART scopes</div>
      <div className="space-y-1">
        {scopes?.map((s) => (
          <div key={s} className="text-xs font-mono bg-indigo-950/40 text-indigo-200 px-2 py-0.5 rounded">{s}</div>
        ))}
      </div>
      {note && <div className="text-[11px] text-gray-500 mt-2 italic">{note}</div>}
    </div>
  );
}

function PAHistory({ events }) {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded p-4">
      <div className="text-xs uppercase tracking-wide text-blue-300 mb-3">
        Prior authorization history
        <span className="ml-2 text-gray-500 normal-case">({events?.length || 0} events)</span>
      </div>

      {!events?.length && (
        <div className="text-sm text-amber-400 bg-amber-950/40 border border-amber-700 rounded p-3">
          No PA events found for this member. Run a CRD hook from the EHR surface to generate activity.
        </div>
      )}

      <div className="space-y-2">
        {events?.map((ev, i) => (
          <div
            key={i}
            className={`rounded border p-3 text-xs ${eventStyle(ev.action)}`}
          >
            <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="font-bold">{ev.action}</span>
                <span className="text-gray-400">[{ev.actor}]</span>
              </div>
              <span className="text-gray-500 shrink-0">{new Date(ev.timestamp).toLocaleString()}</span>
            </div>
            <div className="text-gray-300 whitespace-pre-wrap line-clamp-4">{ev.details}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Row({ label, value, mono }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-gray-400 shrink-0">{label}</span>
      <span className={`text-gray-100 text-right ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
    </div>
  );
}

function eventStyle(action) {
  if (/DENIED|DENIAL/i.test(action)) return 'bg-red-950/30 border-red-700';
  if (/APPROVED/i.test(action)) return 'bg-green-950/30 border-green-700';
  if (/PENDED/i.test(action)) return 'bg-amber-950/30 border-amber-700';
  if (/HOOK RECEIVED|EVALUATION/i.test(action)) return 'bg-yellow-950/20 border-yellow-800';
  if (/COVERAGE-INFORMATION/i.test(action)) return 'bg-fuchsia-950/20 border-fuchsia-800';
  if (/BUNDLE RECEIVED/i.test(action)) return 'bg-blue-950/30 border-blue-700';
  return 'bg-gray-900 border-gray-700';
}
