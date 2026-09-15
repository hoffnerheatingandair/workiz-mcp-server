const DEFAULT_TIMEOUT_MS = 15_000;

export function requestTimeoutMs(provider) {
  const value = Number(process.env[`${provider}_HTTP_TIMEOUT_MS`] || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

export async function fetchWithTimeout(url, options = {}, provider) {
  const signal = AbortSignal.timeout(requestTimeoutMs(provider));
  return fetch(url, { ...options, signal });
}
