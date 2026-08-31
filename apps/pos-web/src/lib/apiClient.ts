import { useAuthStore } from '../store/authStore';
import type { ApiErrorBody } from './apiTypes';

const BASE_URL = import.meta.env.VITE_API_URL;

/** Wraps the API's own error envelope (`{ error: { code, message, details,
 * requestId } }`) so callers can branch on `.code` without re-parsing. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.status = status;
    this.code = body.code;
    this.details = body.details;
    this.requestId = body.requestId;
  }
}

let refreshInFlight: Promise<string | null> | null = null;

/** POST /auth/refresh directly via `fetch` (not `apiFetch`) so a 401 here
 * can never recurse back into itself. */
async function refreshAccessToken(): Promise<string | null> {
  const { refreshToken } = useAuthStore.getState();
  if (!refreshToken) return null;
  try {
    const res = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const { accessToken, refreshToken: nextRefreshToken } = json.data as { accessToken: string; refreshToken: string };
    useAuthStore.getState().setTokens(accessToken, nextRefreshToken);
    return accessToken;
  } catch {
    return null;
  }
}

interface RequestOptions extends RequestInit {
  /** Internal: set on the retried call after a 401, so a second 401 signs the caller out instead of looping. */
  _retried?: boolean;
}

async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { accessToken } = useAuthStore.getState();
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type') && options.body) headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });

  if (res.status === 401 && !options._retried) {
    if (!refreshInFlight) {
      refreshInFlight = refreshAccessToken().finally(() => {
        refreshInFlight = null;
      });
    }
    const newToken = await refreshInFlight;
    if (newToken) {
      return apiFetch<T>(path, { ...options, _retried: true });
    }
    useAuthStore.getState().clear();
    throw new ApiError(401, { code: 'SESSION_EXPIRED', message: 'Your session has expired. Please sign in again.' });
  }

  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    const body: ApiErrorBody = json?.error ?? { code: 'UNKNOWN_ERROR', message: `Request failed with status ${res.status}` };
    throw new ApiError(res.status, body);
  }

  return json as T;
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
};

/** Human-readable fallback for an ApiError, or any other thrown value. */
export function describeError(err: unknown): { title: string; message?: string } {
  if (err instanceof ApiError) {
    return { title: errorTitle(err.code), message: err.message };
  }
  if (err instanceof Error) return { title: 'Something went wrong', message: err.message };
  return { title: 'Something went wrong' };
}

function errorTitle(code: string): string {
  switch (code) {
    case 'VALIDATION_FAILED':
      return 'Check the highlighted fields';
    case 'FORBIDDEN':
      return 'Not permitted';
    case 'UNAUTHORIZED':
    case 'SESSION_EXPIRED':
      return 'Sign-in required';
    case 'NOT_FOUND':
      return 'Not found';
    case 'CONFLICT':
      return 'Cannot complete this action';
    case 'INSUFFICIENT_STOCK':
      return 'Not enough stock';
    default:
      return 'Request failed';
  }
}
