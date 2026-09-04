import { refreshTokenApiUrl, revokeTokenApiUrl } from '../paths';

const ACCESS_TOKEN_KEY = 'icp_auth_token';
const REFRESH_TOKEN_KEY = 'icp_refresh_token';
const TOKEN_EXPIRES_AT_KEY = 'icp_token_expires_at';
const REFRESH_TOKEN_EXPIRES_AT_KEY = 'icp_refresh_token_expires_at';
const ID_TOKEN_KEY = 'icp_id_token';
const REDIRECT_URL_KEY = 'icp_redirect_url';
const OIDC_STATE_KEY = 'icp_oidc_state';
const NOT_AUTHORIZED_KEY = 'icp_not_authorized';

const EXPIRY_BUFFER_MS = 30_000;

export interface NotAuthorizedDetails {
  message: string;
  username?: string;
}

interface TokenData {
  token: string;
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresIn: number;
  idToken?: string;
}

let refreshPromise: Promise<void> | null = null;
let onAuthFailure: (() => void) | null = null;
let onAuthorizationFailure: (() => void) | null = null;

export function setOnAuthFailure(callback: () => void): void {
  onAuthFailure = callback;
}

/**
 * Called instead of onAuthFailure when the server says the session is
 * authenticated but unauthorized. Kept separate because that outcome is
 * terminal: routing it through the normal failure path would send the user back
 * to login, where signing in again just repeats the refusal.
 */
export function setOnAuthorizationFailure(callback: () => void): void {
  onAuthorizationFailure = callback;
}

export function saveNotAuthorized(details: NotAuthorizedDetails): void {
  sessionStorage.setItem(NOT_AUTHORIZED_KEY, JSON.stringify(details));
}

export function getNotAuthorized(): NotAuthorizedDetails | null {
  const stored = sessionStorage.getItem(NOT_AUTHORIZED_KEY);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    sessionStorage.removeItem(NOT_AUTHORIZED_KEY);
    return null;
  }
}

export function clearNotAuthorized(): void {
  sessionStorage.removeItem(NOT_AUTHORIZED_KEY);
}

export function saveTokens(data: TokenData): void {
  const now = Date.now();
  localStorage.setItem(ACCESS_TOKEN_KEY, data.token);
  localStorage.setItem(REFRESH_TOKEN_KEY, data.refreshToken);
  localStorage.setItem(TOKEN_EXPIRES_AT_KEY, String(now + data.expiresIn * 1000));
  localStorage.setItem(REFRESH_TOKEN_EXPIRES_AT_KEY, String(now + data.refreshTokenExpiresIn * 1000));
  // Refresh responses omit it, so keep the one saved at login for id_token_hint at logout.
  if (data.idToken) localStorage.setItem(ID_TOKEN_KEY, data.idToken);
}

export function getIdToken(): string | null {
  return localStorage.getItem(ID_TOKEN_KEY);
}

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function clearTokens(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXPIRES_AT_KEY);
  localStorage.removeItem(REFRESH_TOKEN_EXPIRES_AT_KEY);
  localStorage.removeItem(ID_TOKEN_KEY);
}

export function isAccessTokenExpired(): boolean {
  const expiresAt = localStorage.getItem(TOKEN_EXPIRES_AT_KEY);
  if (!expiresAt) return true;
  return Date.now() >= Number(expiresAt) - EXPIRY_BUFFER_MS;
}

export function isRefreshTokenExpired(): boolean {
  const expiresAt = localStorage.getItem(REFRESH_TOKEN_EXPIRES_AT_KEY);
  if (!expiresAt) return true;
  return Date.now() >= Number(expiresAt) - EXPIRY_BUFFER_MS;
}

async function readNotAuthorizedBody(res: Response): Promise<NotAuthorizedDetails> {
  const body = await res.text();
  try {
    const parsed = JSON.parse(body);
    return { message: parsed.message || body, username: parsed.username };
  } catch {
    return { message: body || 'Your account is not authorized to access this instance.' };
  }
}

export async function refreshAccessToken(): Promise<void> {
  if (refreshPromise) {
    await refreshPromise;
    return;
  }

  refreshPromise = (async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken || isRefreshTokenExpired()) {
      clearTokens();
      onAuthFailure?.();
      return;
    }

    const res = await fetch(refreshTokenApiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) {
      clearTokens();
      // 403 means the user's ICP authorization was removed. Retrying or bouncing
      // through the IdP cannot fix it, so this is a terminal state.
      if (res.status === 403) {
        const details = await readNotAuthorizedBody(res);
        saveNotAuthorized(details);
        (onAuthorizationFailure ?? onAuthFailure)?.();
        return;
      }
      onAuthFailure?.();
      return;
    }

    const data: TokenData & { username: string; displayName: string; permissions: string[] } = await res.json();
    saveTokens(data);

    const userInfo = localStorage.getItem('icp_user');
    if (userInfo) {
      try {
        const existing = JSON.parse(userInfo);
        localStorage.setItem('icp_user', JSON.stringify({ ...existing, username: data.username, displayName: data.displayName, permissions: data.permissions }));
      } catch {
        localStorage.removeItem('icp_user');
      }
    }
  })().finally(() => {
    refreshPromise = null;
  });

  await refreshPromise;
}

export async function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  if (isAccessTokenExpired()) {
    await refreshAccessToken();
  }

  const token = getAccessToken();
  const headers = new Headers(options.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    await refreshAccessToken();
    const retryToken = getAccessToken();
    if (!retryToken) {
      // Refresh failed — onAuthFailure already triggered navigation to login.
      // Return the original 401 so callers receive a clean non-ok response
      // instead of an unauthenticated retry that keeps the UI stuck loading.
      return res;
    }
    const retryHeaders = new Headers(options.headers);
    retryHeaders.set('Authorization', `Bearer ${retryToken}`);
    return fetch(url, { ...options, headers: retryHeaders });
  }

  return res;
}

export async function revokeToken(): Promise<void> {
  try {
    const token = getAccessToken();
    const refreshToken = getRefreshToken();
    if (!token) return;

    await fetch(revokeTokenApiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    // best-effort — ignore errors
  }
}

export function saveRedirectUrl(url: string): void {
  localStorage.setItem(REDIRECT_URL_KEY, url);
}

export function getAndClearRedirectUrl(): string | null {
  const url = localStorage.getItem(REDIRECT_URL_KEY);
  localStorage.removeItem(REDIRECT_URL_KEY);
  return url;
}

export function generateAndSaveOIDCState(): string {
  const state = crypto.randomUUID();
  localStorage.setItem(OIDC_STATE_KEY, state);
  return state;
}

export function validateAndClearOIDCState(state: string): boolean {
  const savedState = localStorage.getItem(OIDC_STATE_KEY);
  localStorage.removeItem(OIDC_STATE_KEY);
  return savedState === state;
}
