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
  <header class="flex flex-wrap items-center gap-4 border-b border-line bg-panel px-4 py-2.5">
    <h1>Guitar Book</h1>
    <button class="border-accent bg-accent-soft font-semibold disabled:opacity-60" :disabled="!!uploading" @click="fileInput.click()">
      {{ uploading ? 'Uploading…' : 'Upload song' }}
    </button>
    <input ref="fileInput" type="file" accept="audio/*,.mp3,.m4a,.wav,.flac,.ogg,.aac" multiple hidden @change="upload">
    <span class="ml-auto text-13 text-muted">{{ auth.state.user?.name || auth.state.user?.email }}</span>
    <button @click="logout">Sign out</button>
  </header>
  <p v-if="error" class="warn my-[13px]" role="alert">{{ error }}</p>
  <main class="mx-auto max-w-[760px] p-4">
    <p v-if="uploading" class="my-[15px] text-muted">Uploading {{ uploading }}…</p>
    <p v-if="loading" class="my-[15px] text-muted">Loading…</p>
    <p v-else-if="!songs.length && !error" class="my-[15px] text-muted">
      No songs yet. Upload a recording (mp3, m4a, wav, flac, ogg or aac, at most 40 MB): its chords, lyrics and timing
      are worked out from it, which takes a few minutes.
    </p>
    <ul v-else class="rounded-[10px] border border-line bg-panel">
      <li v-for="song in sorted" :key="song.id" class="flex items-center border-t border-line first:border-t-0">
        <button class="border-0 bg-transparent py-2.5 pl-3.5 pr-1.5 text-17 leading-none" :class="song.favourite ? 'text-accent' : 'text-muted'"
          :aria-pressed="song.favourite" :title="song.favourite ? 'Remove from favourites' : 'Add to favourites'" @click="toggleFavourite(song)">
          {{ song.favourite ? '★' : '☆' }}
        </button>
        <component :is="song.status === 'ready' ? 'RouterLink' : 'div'"
          class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1.5 px-1.5 py-2.5 text-inherit no-underline"
          :class="{ group: song.status === 'ready' }"
          :to="song.status === 'ready' ? { name: 'player', query: { id: song.id } } : undefined">
          <span class="font-semibold group-hover:text-accent">{{ song.title }}</span>
          <span v-if="song.status !== 'ready'" class="rounded-full px-2 py-px text-12"
            :class="song.status === 'failed' ? 'bg-warn-bg text-warn-ink' : 'bg-accent-soft text-chord'">{{ STATUS[song.status] }}</span>
          <span class="ml-auto text-right text-13 text-muted">{{ detail(song) }}</span>
        </component>
        <span class="flex gap-1.5 pl-1.5 pr-3.5">
          <button v-if="song.status === 'failed'" class="px-2 py-[3px] text-12 text-muted" @click="retry(song)">Try again</button>
          <template v-if="confirming === song.id">
            <button class="border-warn-ink bg-warn-bg px-2 py-[3px] text-12 text-warn-ink" @click="remove(song)">Delete for good</button>
            <button class="px-2 py-[3px] text-12 text-muted" @click="confirming = null">Keep</button>
          </template>
          <button v-else class="px-2 py-[3px] text-12 text-muted" @click="confirming = song.id">Delete</button>
        </span>
      </li>
    </ul>
  </main>
</template>
