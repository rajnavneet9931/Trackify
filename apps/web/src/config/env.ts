/**
 * Typed access to build-time environment variables.
 * Only `VITE_`-prefixed values are exposed to the browser — never put secrets here.
 */
export const env = Object.freeze({
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL ?? '/api/v1').replace(/\/+$/, ''),
  isDev: import.meta.env.DEV,
});
