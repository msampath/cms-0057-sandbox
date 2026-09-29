/**
 * Panel labels for the outbound sandbox integrations (Optum, Availity).
 *
 * In `live` mode the panel shows a response from the vendor's sandbox. In
 * a `mock-*` mode no call is made and the panel shows a stored copy of a
 * sandbox response, so the label says so.
 */
export function sandboxResponseLabel(vendor, mode) {
  if (mode === 'live') return `${vendor} sandbox response`;
  if (typeof mode === 'string' && mode.startsWith('mock')) return `${vendor} sandbox response (saved copy)`;
  if (mode === 'disabled') return `${vendor} integration disabled`;
  return `${vendor} sandbox`;
}

export function isSavedCopy(mode) {
  return typeof mode === 'string' && mode.startsWith('mock');
}
