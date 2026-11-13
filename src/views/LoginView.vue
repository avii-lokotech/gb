<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuth } from '../stores/authStore';
import { errorMessage } from '../lib/api';
import AppButton from '../components/AppButton.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuth();

const email = ref('');
const password = ref('');
const error = ref('');
const submitting = ref(false);

document.title = 'Guitar Book';

const FIELD = 'mb-2 rounded-md border border-line bg-bg px-2.5 py-2 text-ink focus:outline-2 focus:-outline-offset-1 focus:outline-accent';

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
  <main class="grid min-h-dvh place-items-center p-4">
    <form class="grid w-full max-w-sm gap-1.5 rounded-lg border border-line bg-panel p-5" novalidate @submit.prevent="handleSubmit">
      <h1 class="mb-2 text-lg font-bold">Guitar Book</h1>
      <label for="email" class="text-sm text-muted">Email</label>
      <input id="email" v-model.trim="email" :class="FIELD" type="email" autocomplete="username" required />
      <label for="password" class="text-sm text-muted">Password</label>
      <input id="password" v-model="password" :class="FIELD" type="password" autocomplete="current-password" required />
      <p v-if="error" class="mb-2 rounded-md bg-warn-bg px-2.5 py-2 text-sm text-warn-ink" role="alert">{{ error }}</p>
      <AppButton type="submit" variant="primary" size="lg" :disabled="submitting">
        {{ submitting ? 'Signing in…' : 'Sign in' }}
      </AppButton>
    </form>
  </main>
</template>
