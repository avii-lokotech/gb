// The one network wrapper. The Worker (worker/index.ts) answers POST /api/<op> with the logged-in user's data,
// takes uploads and hands out the songs' audio. Every call goes through req() or raw(): Bearer token and
// centralised 401 handling. Add new ops to `api` below.

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

// A GET or a body that is not JSON, with the token → the Response.
async function raw(path, init = {}) {
  const response = await fetch(path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${getToken() ?? ''}` } });
  if (response.status === 401) throw expired();
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(data?.error || `Request failed (${response.status})`, response.status);
  }
  return response;
}

// The Worker's error messages are written for the user, except a 500.
export function errorMessage(error, fallback = 'Something went wrong.') {
  if (!error) return fallback;
  if (error instanceof ApiError && error.status >= 500) return 'The server failed to complete that. Please try again.';
  return error.message || fallback;
}

// --- ops -----------------------------------------------------------------------
// A song is { id, title, artist, status, error, tracks: { instrumental, rhythm }, favourite, speed, loop,
// last_played_at, created_at }. status: uploaded (waiting for the converter), converting, ready, or failed with
// error. speed 1 is 100 %; loop is [first bar, last bar] counted from 0, or null. A nullable timestamp is "".

export const api = {
  // → { token, user: { id, email, name } }. Sessions are stateless; logging out is dropping the token.
  login: (email, password) => req('login', { email, password }, false),

  // → { songs: [...] }: the user's songs, by title.
  listSongs: () => req('listSongs'),
  // → the song with cho (the ChordPro text in use), draft (the text as converted) and sync (the timing); all null
  // until converted.
  getSong: (id) => req('getSong', { id }),
  // The user's edit of the song's text; title and artist follow its directives. → the song.
  saveSongText: (id, cho) => req('saveSongText', { id, cho }),
  // file: a File (a recording). → the new song, waiting for the converter.
  uploadSong: (file) => raw('/api/uploadSong', {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    body: file
  }).then((r) => r.json()),
  // track: mix (the recording), instrumental (vocals removed) or rhythm (drums and bass). → a Blob.
  songAudio: (id, track) => raw(`/api/audio/${id}/${track}`).then((r) => r.blob()),
  // patch: { favourite?, speed?, loop?, played? }; omitted is unchanged, loop null clears it, played true stamps
  // last_played_at. → the song after the change.
  saveSongSetting: (id, patch) => req('saveSongSetting', { id, ...patch }),
  // A failed conversion goes back in the queue. → the song.
  retrySong: (id) => req('retrySong', { id }),
  // The song and its audio, for good.
  deleteSong: (id) => req('deleteSong', { id })
};
