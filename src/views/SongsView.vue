<script setup>
// The user's songs: upload a recording, watch it being converted, open it in the player.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../stores/authStore';

const router = useRouter();
const auth = useAuth();

const songs = ref([]);
const error = ref('');
const loading = ref(true);
const uploading = ref('');      // the name of the file on its way up
const confirming = ref(null);   // the id of the song whose Delete was clicked once
const fileInput = ref(null);

document.title = 'Guitar Book';

// Favourites first, then by title.
const sorted = computed(() => [...songs.value].sort((a, b) =>
  Number(b.favourite) - Number(a.favourite) || a.title.localeCompare(b.title) || a.id - b.id));

const STATUS = { uploaded: 'Waiting for the converter', converting: 'Converting…', failed: 'Conversion failed' };
function detail(song) {
  if (song.status === 'failed') return song.error;
  if (song.status === 'uploaded') return 'Starts when the converter is running.';
  if (song.status === 'converting') return 'This takes a few minutes.';
  const played = song.last_played_at ? `played ${new Date(song.last_played_at).toLocaleDateString()}` : '';
  return [song.artist, played].filter(Boolean).join(' · ');
}

function replace(song) {
  songs.value = songs.value.map((s) => (s.id === song.id ? song : s));
}

// While a song is waiting or converting, the list is read again every few seconds.
let timer = null, gone = false;
async function refresh() {
  clearTimeout(timer);
  try {
    songs.value = (await api.listSongs()).songs;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
  if (!gone && songs.value.some((s) => s.status === 'uploaded' || s.status === 'converting')) timer = setTimeout(refresh, 5000);
}
onMounted(refresh);
onBeforeUnmount(() => { gone = true; clearTimeout(timer); });

async function upload(event) {
  const files = [...event.target.files];
  event.target.value = '';
  error.value = '';
  for (const file of files) {
    uploading.value = file.name;
    try {
      songs.value = [...songs.value, await api.uploadSong(file)];
    } catch (e) {
      error.value = `${file.name}: ${errorMessage(e)}`;
      break;
    }
  }
  uploading.value = '';
  refresh();
}

async function act(call) {
  error.value = '';
  try {
    await call();
  } catch (e) {
    error.value = errorMessage(e);
  }
}
const toggleFavourite = (song) => act(async () => replace(await api.saveSongSetting(song.id, { favourite: !song.favourite })));
const retry = (song) => act(async () => { replace(await api.retrySong(song.id)); refresh(); });
const remove = (song) => act(async () => {
  confirming.value = null;
  await api.deleteSong(song.id);
  songs.value = songs.value.filter((s) => s.id !== song.id);
});

function logout() {
  auth.logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <header>
    <h1>Guitar Book</h1>
    <button class="upload" :disabled="!!uploading" @click="fileInput.click()">{{ uploading ? 'Uploading…' : 'Upload song' }}</button>
    <input ref="fileInput" type="file" accept="audio/*,.mp3,.m4a,.wav,.flac,.ogg,.aac" multiple hidden @change="upload">
    <span class="who">{{ auth.state.user?.name || auth.state.user?.email }}</span>
    <button @click="logout">Sign out</button>
  </header>
  <p v-if="error" class="warn" role="alert">{{ error }}</p>
  <main>
    <p v-if="uploading" class="note">Uploading {{ uploading }}…</p>
    <p v-if="loading" class="note">Loading…</p>
    <p v-else-if="!songs.length && !error" class="note">
      No songs yet. Upload a recording (mp3, m4a, wav, flac, ogg or aac, at most 40 MB): its chords, lyrics and timing
      are worked out from it, which takes a few minutes.
    </p>
    <ul v-else class="songs">
      <li v-for="song in sorted" :key="song.id">
        <button class="star" :class="{ on: song.favourite }" :aria-pressed="song.favourite"
          :title="song.favourite ? 'Remove from favourites' : 'Add to favourites'" @click="toggleFavourite(song)">
          {{ song.favourite ? '★' : '☆' }}
        </button>
        <component :is="song.status === 'ready' ? 'RouterLink' : 'div'" class="song"
          :to="song.status === 'ready' ? { name: 'player', query: { id: song.id } } : undefined">
          <span class="title">{{ song.title }}</span>
          <span v-if="song.status !== 'ready'" class="status" :class="song.status">{{ STATUS[song.status] }}</span>
          <span class="detail">{{ detail(song) }}</span>
        </component>
        <span class="actions">
          <button v-if="song.status === 'failed'" @click="retry(song)">Try again</button>
          <template v-if="confirming === song.id">
            <button class="danger" @click="remove(song)">Delete for good</button>
            <button @click="confirming = null">Keep</button>
          </template>
          <button v-else @click="confirming = song.id">Delete</button>
        </span>
      </li>
    </ul>
  </main>
</template>

<style scoped>
header { background: var(--panel); border-bottom: 1px solid var(--line); padding: 10px 16px; display: flex; gap: 16px;
  align-items: center; flex-wrap: wrap; }
.upload { font-weight: 600; background: var(--accent-soft); border-color: var(--accent); }
.upload:disabled { opacity: .6; }
.who { margin-left: auto; color: var(--muted); font-size: 13px; }
main { max-width: 760px; margin: 0 auto; padding: 16px; }
.note { color: var(--muted); }
.songs { list-style: none; margin: 0; padding: 0; background: var(--panel); border: 1px solid var(--line);
  border-radius: 10px; }
.songs li { display: flex; align-items: center; }
.songs li + li { border-top: 1px solid var(--line); }
.star { border: 0; background: none; font-size: 17px; line-height: 1; padding: 10px 6px 10px 14px; color: var(--muted); }
.star.on { color: var(--accent); background: none; }
.song { flex: 1; min-width: 0; display: flex; gap: 6px 12px; align-items: baseline; flex-wrap: wrap;
  padding: 10px 6px; color: inherit; text-decoration: none; }
a.song:hover .title { color: var(--accent); }
.title { font-weight: 600; }
.status { font-size: 12px; border-radius: 999px; padding: 1px 8px; background: var(--accent-soft); color: var(--chord); }
.status.failed { background: var(--warn-bg); color: var(--warn-ink); }
.detail { color: var(--muted); font-size: 13px; margin-left: auto; text-align: right; }
.actions { display: flex; gap: 6px; padding: 0 14px 0 6px; }
.actions button { font-size: 12px; padding: 3px 8px; color: var(--muted); }
.actions .danger { color: var(--warn-ink); background: var(--warn-bg); border-color: var(--warn-ink); }
</style>
