// The one network wrapper. The Worker (worker/index.ts) answers POST /api/<op> with D1 data scoped to the
// logged-in user, and hands out the song files (songs/ and the recordings) to a logged-in user only. Every call
// goes through req() or fetchFile(): Bearer token and centralised 401 handling. Add new ops to `api` below.

const TOKEN_KEY = 'gb_token';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// --- token storage -----------------------------------------------------------

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function isAuthenticated() {
  return Boolean(getToken());
}

// A 401 from any call clears the token and notifies this handler (wired in main.js to route the user back to
// /login).
let onUnauthorized = null;
export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

function expired() {
  clearToken();
  if (onUnauthorized) onUnauthorized();
  return new ApiError('Session expired — please log in again.', 401);
}

// --- core requests -----------------------------------------------------------

async function req(op, args = {}, auth = true) {
  const headers = { 'Content-Type': 'application/json' };
  const token = auth ? getToken() : null;
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`/api/${op}`, { method: 'POST', headers, body: JSON.stringify(args) });

  // A failed *login* is also a 401, but must not clear a session or bounce to /login.
  if (response.status === 401 && auth) throw expired();

  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error || `Request failed (${response.status})`, response.status);
  return data;
}

// A song file (a path or URL on this site) → its Response. The token never leaves this site: a URL elsewhere,
// e.g. from a song's {x_audio: …}, is refused.
export async function fetchFile(path) {
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin) throw new ApiError(`${url.href} is not on this site.`, 0);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } });
  if (response.status === 401) throw expired();
  if (!response.ok) throw new ApiError(`${url.pathname}: ${response.status}`, response.status);
  return response;
}

// The Worker's error messages are written for the user, except a 500.
export function errorMessage(error, fallback = 'Something went wrong.') {
  if (!error) return fallback;
  if (error instanceof ApiError && error.status >= 500) return 'The server failed to complete that. Please try again.';
  return error.message || fallback;
}

// --- ops -----------------------------------------------------------------------
// A song is its path, e.g. "songs/Madeline.cho". A nullable timestamp is "" (never null).
// A song setting is { song, favourite, speed, loop, last_played_at }: speed 1 is 100 %, loop is [first bar,
// last bar] counted from 0, or null.

export const api = {
  // → { token, user: { id, email, name } }. Sessions are stateless; logging out is dropping the token.
  login: (email, password) => req('login', { email, password }, false),

  // → { settings: [...] }: only the songs the user has touched.
  listSongSettings: () => req('listSongSettings'),
  // → the song's setting; the defaults for a song the user has not touched.
  getSongSetting: (song) => req('getSongSetting', { song }),
  // patch: { favourite?, speed?, loop?, played? }; omitted is unchanged, loop null clears it, played true stamps
  // last_played_at. → the setting after the change.
  saveSongSetting: (song, patch) => req('saveSongSetting', { song, ...patch })
};
