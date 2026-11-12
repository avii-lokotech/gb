import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import { setUnauthorizedHandler } from './lib/api';
import { useAuth } from './stores/authStore';
import './style.css';

// Any 401 from the Worker clears the session and returns the user to /login, and back here after logging in.
const auth = useAuth();
setUnauthorizedHandler(() => {
  auth.logout();
  const from = router.currentRoute.value;
  if (from.name !== 'login') router.push({ name: 'login', query: { redirect: from.fullPath } });
});

const app = createApp(App);
app.use(router);
app.mount('#app');
