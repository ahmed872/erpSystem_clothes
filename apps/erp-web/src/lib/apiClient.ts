import i18n from 'i18next';
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
    // No prose here: the code alone is enough, and `describeError`
    // renders it in the reader's language.
    throw new ApiError(401, { code: 'SESSION_EXPIRED', message: '' });
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
  /** Phase 14 — the catalogue uses PUT where the backend REPLACES rather
   *  than merges: a price-list entry and a bundle's whole composition. */
  put: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
};

/**
 * Phase 12 (POS loose ends, B1) — the error a cashier reads is in the
 * cashier's language.
 *
 * WHAT WAS WRONG. Both halves of every error banner in this app were
 * English: a hardcoded title, and the server's own prose underneath. An
 * Arabic-first till showed an Arabic screen that turned English at exactly
 * the moment something went wrong — the moment the words matter most.
 *
 * WHAT IS LOCALIZED, AND WHAT IS NOT. The TITLE and a plain-language
 * EXPLANATION now come from the translation bundle, keyed by the API's own
 * error code, so the actionable half of every banner is in the reader's
 * language. The server's `message` is kept as supporting DETAIL because it
 * carries the specifics no code can ("this serial was not sold on this
 * sale line", which variant is short) — but it is still English, because
 * the backend emits prose rather than message keys. Closing that last gap
 * is a backend contract change and is reported rather than faked here: a
 * translation table in the browser guessing at server prose would go stale
 * silently the first time a message changed.
 *
 * `i18n.t` is used directly rather than the `useTranslation` hook because
 * this is called from event handlers and query callbacks, not during
 * render.
 */
export function describeError(err: unknown): { title: string; message?: string } {
  if (err instanceof ApiError) {
    return {
      title: i18n.t(`errors.title.${err.code}`, { defaultValue: i18n.t('errors.title.UNKNOWN_ERROR') }),
      // The localized explanation leads; the server's own words follow it
      // when it has something more specific to add.
      message: joinDetail(i18n.t(`errors.hint.${err.code}`, { defaultValue: '' }), err.message),
    };
  }
  if (err instanceof Error) {
    return { title: i18n.t('errors.title.UNKNOWN_ERROR'), message: err.message };
  }
  return { title: i18n.t('errors.title.UNKNOWN_ERROR') };
}

function joinDetail(hint: string, serverMessage?: string): string | undefined {
  const parts = [hint, serverMessage].filter((p): p is string => Boolean(p && p.trim()));
  return parts.length > 0 ? parts.join(' — ') : undefined;
}
