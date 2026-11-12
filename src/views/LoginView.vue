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
  <main class="grid min-h-screen place-items-center p-4">
    <form class="grid w-full max-w-[340px] gap-1.5 rounded-[10px] border border-line bg-panel p-5" novalidate @submit.prevent="handleSubmit">
      <h1 class="mb-2.5">Guitar Book</h1>
      <label for="email" class="text-13 text-muted">Email</label>
      <input id="email" v-model.trim="email" class="field" type="email" autocomplete="username" required />
      <label for="password" class="text-13 text-muted">Password</label>
      <input id="password" v-model="password" class="field" type="password" autocomplete="current-password" required />
      <p v-if="error" class="warn mb-2 rounded-md px-2.5" role="alert">{{ error }}</p>
      <button type="submit" class="border-accent bg-accent-soft px-2.5 py-2 font-semibold disabled:opacity-60" :disabled="submitting">
        {{ submitting ? 'Signing in…' : 'Sign in' }}
      </button>
    </form>
  </main>
</template>
