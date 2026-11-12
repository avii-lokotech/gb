import { createRouter, createWebHistory } from 'vue-router';
import { isAuthenticated } from '../lib/api';
import LoginView from '../views/LoginView.vue';
import SongsView from '../views/SongsView.vue';
import PlayerView from '../views/PlayerView.vue';

const routes = [
  { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
  { path: '/', name: 'songs', component: SongsView, meta: { requiresAuth: true } },
  {
    // ?song=songs/<Name>.cho
    path: '/player',
    name: 'player',
    component: PlayerView,
    props: (route) => ({ song: String(route.query.song || '') }),
    beforeEnter: (to) => (to.query.song ? true : { name: 'songs' }),
    meta: { requiresAuth: true }
  },
  { path: '/:pathMatch(.*)*', redirect: { name: 'songs' } }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

// Auth guard: unauthenticated visits to protected pages go to /login (preserving the intended destination); an
// already-authenticated user is bounced off /login.
router.beforeEach((to) => {
  const authed = isAuthenticated();
  if (to.meta.requiresAuth && !authed) return { name: 'login', query: { redirect: to.fullPath } };
  if (to.name === 'login' && authed) return { name: 'songs' };
  return true;
});

export default router;
