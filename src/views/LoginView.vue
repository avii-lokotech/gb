<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuth } from '../stores/authStore';
import { errorMessage } from '../lib/api';

const route = useRoute();
const router = useRouter();
const auth = useAuth();

const email = ref('');
const password = ref('');
const error = ref('');
const submitting = ref(false);

document.title = 'Guitar Book';

async function handleSubmit() {
  error.value = '';
  submitting.value = true;
  try {
    await auth.login(email.value, password.value);
    const redirect = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/') ? route.query.redirect : null;
    router.push(redirect || { name: 'songs' });
  } catch (err) {
    error.value = errorMessage(err, 'Sign in failed.');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main>
    <form class="card" novalidate @submit.prevent="handleSubmit">
      <h1>Guitar Book</h1>
      <label for="email">Email</label>
      <input id="email" v-model.trim="email" type="email" autocomplete="username" required />
      <label for="password">Password</label>
      <input id="password" v-model="password" type="password" autocomplete="current-password" required />
      <p v-if="error" class="warn" role="alert">{{ error }}</p>
      <button type="submit" :disabled="submitting">{{ submitting ? 'Signing in…' : 'Sign in' }}</button>
    </form>
  </main>
</template>

<style scoped>
main { min-height: 100vh; display: grid; place-items: center; padding: 16px; }
.card { width: 100%; max-width: 340px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  padding: 20px; display: grid; gap: 6px; }
h1 { margin-bottom: 10px; }
label { font-size: 13px; color: var(--muted); }
input { font: inherit; color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
  padding: 7px 10px; margin-bottom: 8px; }
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.warn { border-radius: 6px; margin: 0 0 8px; padding: 8px 10px; }
button { padding: 8px 10px; font-weight: 600; background: var(--accent-soft); border-color: var(--accent); }
button:disabled { opacity: .6; }
</style>
