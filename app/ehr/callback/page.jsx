'use client';
import { useEffect, useState } from 'react';
import { completeLaunch } from '@/lib/smartLaunch';
import { BASE_PATH } from '@/lib/basePath';

/**
 * OAuth callback for the SMART on FHIR EHR launch flow.
 *
 * The external EHR redirects here with code + state after the user
 * approves the launch. This page exchanges the code for a token, stashes
 * the launched-session context in sessionStorage, and hands off to the
 * main /ehr surface.
 */
export default function CallbackPage() {
  const [message, setMessage] = useState('Exchanging authorization code...');
  const [error, setError] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const oauthError = params.get('error');

    if (oauthError) {
      setError(`${oauthError}: ${params.get('error_description') || ''}`);
      return;
    }
    if (!code || !state) {
      setError('Missing code or state in callback URL');
      return;
    }

    const redirectUri = `${window.location.origin}${BASE_PATH}/ehr/callback`;

    completeLaunch({ code, state, redirectUri })
      .then((session) => {
        setMessage(`Launched. Patient ${session.patientId || '(none)'}. Redirecting...`);
        window.location.replace(`${BASE_PATH}/ehr`);
      })
      .catch((e) => setError(e.message || 'Token exchange failed'));
  }, []);

  return (
    <main className="min-h-screen bg-slate-900 text-slate-100 p-8">
      <div className="max-w-2xl mx-auto">
        <div className="text-xs uppercase tracking-widest text-emerald-400 mb-3">
          SMART on FHIR callback
        </div>
        <h1 className="text-2xl font-bold mb-4">Finishing launch</h1>
        {error ? (
          <div className="bg-red-900/40 border border-red-700 rounded p-4 text-red-200">
            <div className="font-semibold mb-2">Callback failed</div>
            <div className="text-sm font-mono break-all">{error}</div>
          </div>
        ) : (
          <div className="text-slate-300">{message}</div>
        )}
      </div>
    </main>
  );
}
