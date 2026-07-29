'use client';
import { useEffect, useState } from 'react';
import { beginStandaloneLaunch } from '@/lib/smartLaunch';
import { BASE_PATH } from '@/lib/basePath';

// Same lookup as /ehr/launch — see comment there.
// Epic issues two client IDs per app: production and non-production.
// Non-production is the correct one for sandbox testing per SMART v1
// convention, but Epic's sandbox is sometimes quirky about which it
// accepts. Support ?client=prod to swap for debugging.
const EPIC_HOST = 'fhir.epic.com';
const EPIC_CLIENTS = {
  nonprod: '818d7a76-11e0-40b5-b51b-55bb8e86dc87',
  prod: 'ab954c75-2f75-47c2-8d49-a89d18649276'
};
const CLIENT_ID_BY_HOST = {
  'launch.smarthealthit.org': 'cms-0057-sandbox-public',
  [EPIC_HOST]: EPIC_CLIENTS.nonprod
};
const DEFAULT_CLIENT_ID = 'cms-0057-sandbox-public';

// Default target when no iss query param is supplied. Epic's sandbox R4
// endpoint is by far the most useful standalone target because Epic gives
// out public provider-facing test users (FHIR / FHIRTWO) and a fixed set
// of test patients.
const DEFAULT_ISS = 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4';

function clientIdFor(iss, epicVariant) {
  try {
    const host = new URL(iss).host;
    if (host === EPIC_HOST && epicVariant && EPIC_CLIENTS[epicVariant]) {
      return EPIC_CLIENTS[epicVariant];
    }
    return CLIENT_ID_BY_HOST[host] || DEFAULT_CLIENT_ID;
  } catch {
    return DEFAULT_CLIENT_ID;
  }
}

/**
 * Standalone SMART on FHIR launch entry point. Unlike /ehr/launch this is
 * initiated by the user (or by a link on /ehr), not by an EHR redirect.
 * There is no `launch` context to relay; the FHIR server handles patient
 * selection at its own login flow.
 *
 * Query params: `iss` (optional, defaults to Epic sandbox R4).
 *
 * Test Epic sandbox users (from open.epic.com):
 *   FHIRTWO / EpicFhir11!   (provider with PractitionerRole)
 *   FHIR    / EpicFhir11!   (provider without PractitionerRole)
 */
export default function StandaloneLaunchPage() {
  const [message, setMessage] = useState('Starting standalone launch...');
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const iss = params.get('iss') || DEFAULT_ISS;
    const epicVariant = params.get('client');
    const redirectUri = `${window.location.origin}${BASE_PATH}/ehr/callback`;
    const clientId = clientIdFor(iss, epicVariant);
    setMessage(`Discovering ${new URL(iss).host}... (client_id ${clientId.slice(0, 8)}...)`);

    beginStandaloneLaunch({ iss, redirectUri, clientId })
      .then((authorizeUrl) => {
        setMessage(`Redirecting to ${new URL(authorizeUrl).host}...`);
        window.location.assign(authorizeUrl);
      })
      .catch((e) => setError(e.message || 'Standalone launch failed'));
  }, []);

  return (
    <main className="min-h-screen bg-slate-900 text-slate-100 p-8">
      <div className="max-w-2xl mx-auto">
        <div className="text-xs uppercase tracking-widest text-emerald-400 mb-3">
          SMART on FHIR standalone launch
        </div>
        <h1 className="text-2xl font-bold mb-4">Handshaking with the FHIR server</h1>
        {error ? (
          <div className="bg-red-900/40 border border-red-700 rounded p-4 text-red-200">
            <div className="font-semibold mb-2">Standalone launch failed</div>
            <div className="text-sm font-mono break-all">{error}</div>
          </div>
        ) : (
          <div className="text-slate-300">{message}</div>
        )}
      </div>
    </main>
  );
}
