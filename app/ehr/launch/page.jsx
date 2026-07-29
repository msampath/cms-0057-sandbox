'use client';
import { useEffect, useState } from 'react';
import { beginLaunch } from '@/lib/smartLaunch';
import { BASE_PATH } from '@/lib/basePath';

// Per-EHR client_id lookup, keyed by the launching FHIR server's host.
// Public clients only, no secret. Add a new EHR by registering the app at
// that vendor's developer portal (launch URL = /ehr/launch, redirect URI
// = /ehr/callback) and dropping the issued non-production client_id here.
const CLIENT_ID_BY_HOST = {
  // SMART Health IT reference launcher accepts any string for public apps.
  'launch.smarthealthit.org': 'cms-0057-sandbox-public',
  // Epic sandbox (fhir.epic.com), non-production. Registered under this
  // developer account: msampath. Regenerate if the app is deleted.
  'fhir.epic.com': 'cfb74462-c737-433c-9ceb-b484c4e08261'
};
const DEFAULT_CLIENT_ID = 'cms-0057-sandbox-public';

function clientIdFor(iss) {
  try {
    return CLIENT_ID_BY_HOST[new URL(iss).host] || DEFAULT_CLIENT_ID;
  } catch {
    return DEFAULT_CLIENT_ID;
  }
}

/**
 * SMART on FHIR EHR launch endpoint.
 *
 * Registered with the external EHR as this app's Launch URL. The EHR
 * redirects here with iss + launch query params. This page discovers the
 * SMART configuration at the FHIR base, generates PKCE, and redirects to
 * the EHR's authorize endpoint.
 *
 * Test locally with SMART App Launcher (launch.smarthealthit.org):
 *   1. Set the App Launch URL to http://localhost:3000/cms-0057/ehr/launch
 *   2. Set the Redirect URIs (regex) to http://localhost:3000/cms-0057/ehr/callback
 *   3. Click Launch and pick any patient
 */
export default function LaunchPage() {
  const [message, setMessage] = useState('Launching...');
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const iss = params.get('iss');
    const launch = params.get('launch');

    if (!iss || !launch) {
      setError(
        'This URL is the SMART launch endpoint and must be opened by an EHR sandbox. Missing iss or launch query parameter.'
      );
      return;
    }

    const redirectUri = `${window.location.origin}${BASE_PATH}/ehr/callback`;
    const clientId = clientIdFor(iss);

    beginLaunch({ iss, launch, redirectUri, clientId })
      .then((authorizeUrl) => {
        setMessage(`Redirecting to ${new URL(authorizeUrl).host}...`);
        window.location.assign(authorizeUrl);
      })
      .catch((e) => setError(e.message || 'Launch failed'));
  }, []);

  return (
    <main className="min-h-screen bg-slate-900 text-slate-100 p-8">
      <div className="max-w-2xl mx-auto">
        <div className="text-xs uppercase tracking-widest text-emerald-400 mb-3">
          SMART on FHIR launch
        </div>
        <h1 className="text-2xl font-bold mb-4">
          Handshaking with the launching EHR
        </h1>
        {error ? (
          <div className="bg-red-900/40 border border-red-700 rounded p-4 text-red-200">
            <div className="font-semibold mb-2">Launch failed</div>
            <div className="text-sm font-mono">{error}</div>
          </div>
        ) : (
          <div className="text-slate-300">{message}</div>
        )}
      </div>
    </main>
  );
}
