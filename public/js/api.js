/**
 * API client for the test harness.
 *
 * Two things here are worth more than the rest of the file:
 *
 *  - The access token is held in memory, not localStorage. It lives 15 minutes
 *    and the refresh cookie is httpOnly, so a page reload re-authenticates
 *    silently. Putting it in localStorage would hand it to any XSS on the page
 *    for no benefit.
 *  - A 401 triggers exactly one refresh attempt, and concurrent 401s share it.
 *    Refresh tokens rotate on use, so firing several refreshes at once would
 *    make all but the first look like a replayed token — which the server
 *    correctly treats as theft and responds to by killing the session.
 */
const BASE = '/api/v1';

let accessToken = null;
let currentUser = null;
let refreshInFlight = null;

const listeners = new Set();

export function onAuthChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce() {
  for (const listener of listeners) listener(currentUser);
}

export function getUser() {
  return currentUser;
}

export function isSignedIn() {
  return Boolean(currentUser);
}

export function hasRole(...roles) {
  return Boolean(currentUser) && roles.includes(currentUser.role);
}

function setSession({ user, accessToken: token }) {
  currentUser = user ?? currentUser;
  if (token) accessToken = token;
  announce();
}

function clearSession() {
  accessToken = null;
  currentUser = null;
  announce();
}

/** An API error carrying the server's own code and field details. */
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details ?? null;
  }

  /** "email: Must be a valid email address" — the shape the forms display. */
  get fieldSummary() {
    if (!Array.isArray(this.details)) return null;
    return this.details.map((detail) => `${detail.field}: ${detail.message}`).join('\n');
  }
}

async function parse(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function refreshSession() {
  // One refresh at a time: rotation means a second concurrent attempt would
  // present an already-used token and be rejected as a replay.
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'same-origin',
      });

      if (!response.ok) return false;

      const body = await parse(response);
      setSession(body.data);
      return true;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so callers awaiting this one still share it.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();

  return refreshInFlight;
}

async function send(method, path, { body, formData, retry = true } = {}) {
  const headers = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(BASE + path, {
    method,
    headers,
    credentials: 'same-origin',
    body: formData ?? (body === undefined ? undefined : JSON.stringify(body)),
  });

  if (response.status === 401 && retry) {
    // Only worth retrying if a session existed; a failed login is a real 401.
    const refreshed = await refreshSession();
    if (refreshed) return send(method, path, { body, formData, retry: false });
    clearSession();
  }

  const parsed = await parse(response);
  if (!response.ok) throw new ApiError(response.status, parsed);

  return parsed;
}

export const api = {
  get: (path) => send('GET', path),
  post: (path, body) => send('POST', path, { body }),
  patch: (path, body) => send('PATCH', path, { body }),
  delete: (path) => send('DELETE', path),
  upload: (path, formData) => send('POST', path, { formData }),
};

export const auth = {
  async register(payload) {
    const body = await api.post('/auth/register', payload);
    setSession(body.data);
    return body.data.user;
  },

  async login(email, password) {
    const body = await api.post('/auth/login', { email, password });
    setSession(body.data);
    return body.data.user;
  },

  async logout() {
    try {
      await api.post('/auth/logout');
    } finally {
      clearSession();
    }
  },

  /** Called once on load: the refresh cookie survives a reload, the token does not. */
  async restore() {
    const refreshed = await refreshSession();
    if (!refreshed) return null;

    try {
      const body = await api.get('/users/me');
      setSession({ user: body.data.user });
      return body.data.user;
    } catch {
      clearSession();
      return null;
    }
  },
};

/** Builds a query string, dropping empty values so blank filters are omitted. */
export function query(params) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, value);
  }

  const string = search.toString();
  return string ? `?${string}` : '';
}
