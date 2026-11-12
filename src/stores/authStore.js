// Auth state: the JWT plus the logged-in user. The token itself lives in localStorage (see lib/api.js); this
// store mirrors it reactively for the UI and caches the user returned by login.
import { reactive, computed } from 'vue';
import { api, getToken, setToken, clearToken } from '../lib/api';

const USER_KEY = 'gb_user';

function loadUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

const state = reactive({
  token: getToken(),
  user: loadUser()
});

const isAuthenticated = computed(() => Boolean(state.token));

async function login(email, password) {
  const result = await api.login(email, password);
  setToken(result.token);
  state.token = result.token;
  state.user = result.user ?? null;
  localStorage.setItem(USER_KEY, JSON.stringify(state.user));
  return result;
}

function logout() {
  // Sessions are stateless JWTs: dropping the token is the logout (it expires after 7 days).
  clearToken();
  localStorage.removeItem(USER_KEY);
  state.token = null;
  state.user = null;
}

export function useAuth() {
  return { state, isAuthenticated, login, logout };
}
