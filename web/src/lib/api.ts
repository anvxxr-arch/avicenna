/**
 * Typed client for the Avicenna backend.
 *
 * Every backend row (Go `serve`, Bun api server) answers with the uniform
 * envelope `{ api, version, data }` on success and
 * `{ api, version, error: { code, message } }` on failure, so one parser
 * covers every route.
 */

/**
 * The error classes the server can answer with — the frontend's copy of
 * `apiErrorCodes` in `api_go.go`. `bun run web:routes` fails the build when a
 * class listed here is not one the server actually emits, so the two cannot
 * drift apart silently.
 */
export type ApiErrorCode =
  | 'bad_request'
  | 'method_not_allowed'
  | 'not_found'
  | 'unauthorized'
  | 'rate_limited'
  | 'upstream_error'
  | 'internal';

export interface ApiError {
  code: ApiErrorCode;
  message: string;
}

export interface Envelope<T> {
  api: string;
  version: string;
  data?: T;
  error?: ApiError;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** Base URL; same-origin `/api` in production, overridable for local dev. */
export const API_BASE = (import.meta.env?.VITE_API_BASE as string | undefined) ?? '/api/v1';

export async function apiGet<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === '') continue;
    qs.set(k, String(v));
  }
  const url = `${API_BASE}${path}${qs.size ? `?${qs}` : ''}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  let body: Envelope<T> | null = null;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    throw new ApiRequestError(res.status, 'internal', `${res.status} ${res.statusText} (non-JSON response)`);
  }
  if (!res.ok || body.error) {
    const e = body.error;
    const code = typeof e === 'object' && e ? e.code : 'internal';
    const message = typeof e === 'object' && e ? e.message : `HTTP ${res.status} ${res.statusText}`;
    throw new ApiRequestError(res.status, code, message);
  }
  if (!('data' in body)) {
    // a proxy or gateway answered with a foreign shape: say so instead of
    // silently rendering an empty payload
    throw new ApiRequestError(res.status, 'internal', 'response is not an Avicenna envelope');
  }
  return body.data as T;
}
