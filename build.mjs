// Builds the site into dist/: the Vue SPA (vite build), then the song files at their paths in the repo, so a
// song's own references ({x_audio: ../Name.mp3}) resolve: songs/ and the recordings in the root.
// Only the SPA and what is listed here is published; nothing else in the repo is.
// vite.config.js is imported by Node instead of by Vite's CLI: the CLI writes a bundled copy of the config next
// to it, which fails on the read-only checkout of the local containers.
import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { build } from 'vite';
import config from './vite.config.js';

await build({ ...config, configFile: false }); // empties dist/ first

cpSync('songs', 'dist/songs', { recursive: true, filter: (path) => !path.endsWith('.DS_Store') });
for (const name of readdirSync('.')) if (name.endsWith('.mp3')) cpSync(name, `dist/${name}`);

// songs/index.json: the song list of the home page, from each .cho's {title: …} and {artist: …}.
const directive = (text, name) => text.match(new RegExp(`^\\{${name}:\\s*(.*?)\\s*\\}`, 'm'))?.[1] ?? '';
const songs = readdirSync('songs')
  .filter((name) => name.endsWith('.cho'))
  .sort()
  .map((name) => {
    const text = readFileSync(`songs/${name}`, 'utf8');
    return { path: `songs/${name}`, title: directive(text, 'title') || name.slice(0, -4), artist: directive(text, 'artist') };
  });
writeFileSync('dist/songs/index.json', JSON.stringify(songs));
