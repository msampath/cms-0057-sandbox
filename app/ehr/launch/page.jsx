'use client';
import { useEffect, useState } from 'react';
import { beginLaunch } from '@/lib/smartLaunch';
import { BASE_PATH } from '@/lib/basePath';

// Public client_id — SMART sandboxes (SMART App Launcher, Epic sandbox)
// accept any string for public apps. Chosen to be identifiable in launcher
// logs; production against a real EHR would use a registered client id.
const CLIENT_ID = 'cms-0057-sandbox-public';

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

    beginLaunch({ iss, launch, redirectUri, clientId: CLIENT_ID })
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
