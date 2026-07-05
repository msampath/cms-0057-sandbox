/**
 * The app is served under /cms-0057 (next.config.js basePath) so it can sit
 * behind one CloudFront distribution alongside the portfolio site at the
 * domain root. next/link hrefs and static assets get the prefix
 * automatically; literal fetch() URLs do not, so every client-side API call
 * goes through apiUrl().
 */
export const BASE_PATH = '/cms-0057';

export function apiUrl(path) {
  return `${BASE_PATH}${path}`;
}
