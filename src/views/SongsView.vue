<script setup>
// The user's songs: upload a recording, watch it being converted, open it in the player.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../stores/authStore';
import { nextTheme, theme } from '../lib/theme.js';
import AppButton from '../components/AppButton.vue';
import AppNotice from '../components/AppNotice.vue';

const router = useRouter();
const auth = useAuth();

const songs = ref([]);
const error = ref('');
const loading = ref(true);
const uploading = ref('');      // the name of the file on its way up
const confirming = ref(null);   // { id, what }: the song whose Delete or Convert again was clicked once
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
const retry = (song) => act(async () => { confirming.value = null; replace(await api.retrySong(song.id)); refresh(); });
const asking = (song, what) => confirming.value?.id === song.id && confirming.value.what === what;
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
  <header class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-panel px-3 py-2.5 sm:px-4">
    <h1 class="text-lg font-bold">Guitar Book</h1>
    <AppButton variant="primary" :disabled="!!uploading" @click="fileInput.click()">
      {{ uploading ? 'Uploading…' : 'Upload song' }}
    </AppButton>
    <input ref="fileInput" type="file" accept="audio/*,.mp3,.m4a,.wav,.flac,.ogg,.aac" multiple hidden @change="upload">
    <span class="ml-auto text-sm text-muted">{{ auth.state.user?.name || auth.state.user?.email }}</span>
    <AppButton title="Colour theme: follow the device, light or dark" @click="nextTheme">Theme: {{ theme }}</AppButton>
    <AppButton @click="logout">Sign out</AppButton>
  </header>
  <AppNotice v-if="error" role="alert">{{ error }}</AppNotice>
  <main class="mx-auto max-w-3xl p-3 sm:p-4">
    <p v-if="uploading" class="my-4 text-muted">Uploading {{ uploading }}…</p>
    <p v-if="loading" class="my-4 text-muted">Loading…</p>
    <p v-else-if="!songs.length && !error" class="my-4 text-muted">
      No songs yet. Upload a recording (mp3, m4a, wav, flac, ogg or aac, at most 40 MB): its chords, lyrics and timing
      are worked out from it, which takes a few minutes.
    </p>
    <ul v-else class="rounded-lg border border-line bg-panel">
      <!-- phone: star and title, then what is known about the song, then its actions; from sm: on one line -->
      <li v-for="song in sorted" :key="song.id" class="flex flex-wrap items-center border-t border-line first:border-t-0">
        <button class="cursor-pointer rounded-md py-2.5 pl-3.5 pr-1.5 text-lg leading-none" :class="song.favourite ? 'text-accent' : 'text-muted'"
          :aria-pressed="song.favourite" :title="song.favourite ? 'Remove from favourites' : 'Add to favourites'" @click="toggleFavourite(song)">
          {{ song.favourite ? '★' : '☆' }}
        </button>
        <component :is="song.status === 'ready' ? 'RouterLink' : 'div'"
          class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1 px-1.5 py-2.5 text-inherit no-underline"
          :class="{ group: song.status === 'ready' }"
          :to="song.status === 'ready' ? { name: 'player', query: { id: song.id } } : undefined">
          <span class="font-semibold group-hover:text-accent">{{ song.title }}</span>
          <span v-if="song.status !== 'ready'" class="rounded-full px-2 py-px text-xs"
            :class="song.status === 'failed' ? 'bg-warn-bg text-warn-ink' : 'bg-accent-soft text-chord'">{{ STATUS[song.status] }}</span>
          <span class="basis-full text-sm text-muted sm:ml-auto sm:basis-auto sm:text-right">{{ detail(song) }}</span>
        </component>
        <span class="flex basis-full justify-end gap-1.5 px-3.5 pb-2.5 sm:basis-auto sm:pb-0 sm:pl-1.5">
          <AppButton v-if="song.status === 'failed'" size="sm" variant="quiet" @click="retry(song)">Try again</AppButton>
          <template v-if="asking(song, 'delete')">
            <AppButton size="sm" variant="danger" @click="remove(song)">Delete for good</AppButton>
            <AppButton size="sm" variant="quiet" @click="confirming = null">Keep</AppButton>
          </template>
          <template v-else-if="asking(song, 'convert')">
            <AppButton size="sm" variant="danger" title="The new conversion replaces the song's text, including your edits"
              @click="retry(song)">Convert and replace my edits</AppButton>
            <AppButton size="sm" variant="quiet" @click="confirming = null">Keep</AppButton>
          </template>
          <template v-else>
            <AppButton v-if="song.status === 'ready'" size="sm" variant="quiet" title="The song bar by bar: its beats and the words next to them"
              @click="router.push({ name: 'beats', query: { id: song.id } })">Beats</AppButton>
            <AppButton v-if="song.status === 'ready'" size="sm" variant="quiet" title="Run the conversion again, e.g. after the converter was improved"
              @click="confirming = { id: song.id, what: 'convert' }">Convert again</AppButton>
            <AppButton size="sm" variant="quiet" @click="confirming = { id: song.id, what: 'delete' }">Delete</AppButton>
          </template>
        </span>
      </li>
    </ul>
  </main>
</template>
