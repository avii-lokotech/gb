<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, errorMessage, fetchFile } from '../lib/api';
import { useAuth } from '../stores/authStore';

const router = useRouter();
const auth = useAuth();

const songs = ref([]);      // [{ path, title, artist }], from the build (songs/index.json)
const settings = ref({});   // song path → the user's setting
const error = ref('');
const loading = ref(true);

document.title = 'Guitar Book';

onMounted(async () => {
  try {
    const [list, mine] = await Promise.all([fetchFile('/songs/index.json').then((r) => r.json()), api.listSongSettings()]);
    songs.value = list;
    settings.value = Object.fromEntries(mine.settings.map((s) => [s.song, s]));
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
});

// Favourites first, then by title.
const sorted = computed(() => [...songs.value].sort((a, b) =>
  Number(isFavourite(b)) - Number(isFavourite(a)) || a.title.localeCompare(b.title)));

const isFavourite = (song) => Boolean(settings.value[song.path]?.favourite);

function lastPlayed(song) {
  const at = settings.value[song.path]?.last_played_at;
  return at ? `played ${new Date(at).toLocaleDateString()}` : '';
}

async function toggleFavourite(song) {
  error.value = '';
  try {
    const saved = await api.saveSongSetting(song.path, { favourite: !isFavourite(song) });
    settings.value = { ...settings.value, [song.path]: saved };
  } catch (e) {
    error.value = errorMessage(e);
  }
}

function logout() {
  auth.logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <header>
    <h1>Guitar Book</h1>
    <span class="who">{{ auth.state.user?.name || auth.state.user?.email }}</span>
    <button @click="logout">Sign out</button>
  </header>
  <p v-if="error" class="warn" role="alert">{{ error }}</p>
  <main>
    <p v-if="loading" class="empty">Loading…</p>
    <p v-else-if="!songs.length && !error" class="empty">No songs yet.</p>
    <ul v-else class="songs">
      <li v-for="song in sorted" :key="song.path">
        <button class="star" :class="{ on: isFavourite(song) }" :aria-pressed="isFavourite(song)"
          :title="isFavourite(song) ? 'Remove from favourites' : 'Add to favourites'" @click="toggleFavourite(song)">
          {{ isFavourite(song) ? '★' : '☆' }}
        </button>
        <RouterLink :to="{ name: 'player', query: { song: song.path } }">
          <span class="title">{{ song.title }}</span>
          <span class="artist">{{ [song.artist, lastPlayed(song)].filter(Boolean).join(' · ') }}</span>
        </RouterLink>
      </li>
    </ul>
  </main>
</template>

<style scoped>
header { background: var(--panel); border-bottom: 1px solid var(--line); padding: 10px 16px; display: flex; gap: 16px;
  align-items: center; }
.who { margin-left: auto; color: var(--muted); font-size: 13px; }
main { max-width: 640px; margin: 0 auto; padding: 16px; }
.empty { color: var(--muted); }
.songs { list-style: none; margin: 0; padding: 0; background: var(--panel); border: 1px solid var(--line);
  border-radius: 10px; }
.songs li { display: flex; align-items: center; }
.songs li + li { border-top: 1px solid var(--line); }
.star { border: 0; background: none; font-size: 17px; line-height: 1; padding: 10px 6px 10px 14px; color: var(--muted); }
.star.on { color: var(--accent); background: none; }
.songs a { flex: 1; min-width: 0; display: flex; gap: 16px; justify-content: space-between; align-items: baseline;
  padding: 10px 14px 10px 6px; color: inherit; text-decoration: none; }
.songs a:hover .title { color: var(--accent); }
.title { font-weight: 600; }
.artist { color: var(--muted); font-size: 13px; text-align: right; }
</style>
