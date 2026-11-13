// The colour theme: "system" follows the device's light/dark setting (src/style.css does that by itself);
// "light" and "dark" fix it, as data-theme on <html>. The choice is kept in this browser.
import { ref } from 'vue';

const KEY = 'gb_theme';
const CHOICES = ['system', 'light', 'dark'];

function stored() {
  try {
    const v = localStorage.getItem(KEY);
    return CHOICES.includes(v) ? v : 'system';
  } catch (e) { return 'system'; }
}

export const theme = ref(stored());

function apply() {
  if (theme.value === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme.value;
}

// The next choice: system → light → dark → system.
export function nextTheme() {
  theme.value = CHOICES[(CHOICES.indexOf(theme.value) + 1) % CHOICES.length];
  try { localStorage.setItem(KEY, theme.value); } catch (e) { /* storage blocked: for this visit only */ }
  apply();
}

apply();
