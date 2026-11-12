# gb

The guitar book at **https://www.gb-songs.com**: one Cloudflare Worker (`gb`, `wrangler.jsonc`) that serves a Vue 3 +
Vite SPA from `dist/`, hands out the song files to logged-in users, and keeps its data in the D1 database `gb-db`
(binding `DB`).

- `src/` — the SPA: login, the song list (`views/SongsView.vue`) and the player (`views/PlayerView.vue` with
  `components/SongSheet.vue`; parsing and layout in `lib/song.js`). All network calls go through `src/lib/api.js`.
- `worker/` — the Worker. `POST /api/login` returns a JWT; `POST /api/<op>` runs one op (`worker/ops/`) for the
  logged-in user. The song files (`/songs/*` and the recordings, `/*.mp3`) also go through the Worker and need the
  same token; everything else is the SPA, served by Cloudflare with SPA fallback.
- `migrations/` — the D1 schema: `user` (the logins) and `song_setting` (per user and song: favourite, speed,
  practice loop, last played).
- `songs/` — ChordPro songs with their timing and audio files. `tools/song2cho/` drafts one from a recording.
- `tools/player/` — the original single-file player, for use without the site (`tools/player/serve.sh`). It is not
  published; the site's player is the Vue port of it.

## Deploy

Workers Builds deploys every push to `main` (connect the repository once in the Cloudflare dashboard):

| Setting | Value |
|---|---|
| Repository / branch / root | `avii-lokotech/gb`, `main`, `/` |
| Build command | none (`npm ci` runs anyway) |
| Deploy command | `npx wrangler d1 migrations apply gb-db --remote && npx wrangler deploy`: the pending migrations, then the deploy, which runs `wrangler.jsonc`'s build command (`npm run build`: the site into `dist/` + Worker typecheck) |
| Project name | `gb`, the `name` in `wrangler.jsonc` |
| API token | Account → Workers Scripts Edit, D1 Edit, Account Settings Read; Zone `gb-songs.com` → Workers Routes Edit (the Custom Domain) |

The D1 database is `gb-db`, `database_id` `4b86277f-935a-4936-8558-6366d355e2b3` in `wrangler.jsonc`.

Once, before the first deploy:

1. The zone `gb-songs.com` must be active in the Cloudflare account. The deploy then creates the DNS record and
   certificate of `www.gb-songs.com` itself; there is no `workers.dev` URL.
2. Set the secret `JWT_SECRET` (dashboard → Worker → Settings → Variables and Secrets, or
   `wrangler secret put JWT_SECRET`) to a long random value. Without it (or under 16 characters) every login is
   refused. Changing it logs everyone out.

`build.mjs` publishes the SPA, `songs/` and the `*.mp3` in the root. Nothing else in the repo is served. A push
deploys only what is committed, so a song's files must be in git to be online; on the site they are only handed to a
logged-in user.

## Users

There is no sign-up. Create a login in the live D1 from the host (OpenSSL 3, curl, jq; see `-h`):

```bash
bin/cloudflare_add_user.sh -t <token with D1 Edit> -e you@example.com [-n "Your Name"]
```

A session lasts 7 days (a stateless JWT in the browser's localStorage); signing out drops it. Ten failed logins in a
row lock a login for 15 minutes. Setting `user.disabled_at` refuses new logins; a session already issued runs out
on its own.

## Database

A schema change is a new file `migrations/NNNN_name.sql`; never edit one that has been deployed. The deploy command
applies it to the live D1, `bin/start_local_dev.sh` to the local one. `song_setting` knows a song by its path
(`songs/<Name>.cho`), since the songs are files. The player's beat offset (tap to sync) is not in the database: it
belongs to the device playing and stays in its browser.

Add an op as an exported function in `worker/ops/` and a method on `api` in `src/lib/api.js`. Every op gets the
logged-in user's id and must scope its queries by it.

## Local development

Everything runs in Docker; nothing is installed on the host.

```bash
bin/start_local_dev.sh [-b]   # migrations, then wrangler dev on http://127.0.0.1:8791 (build at start and on every change)
t/local_seed.sh               # the test login of the local D1; email and password in its -h
bin/local_add_user.sh -e EMAIL [-n NAME]   # another local login
bin/dry_run.sh [-b]           # what a push would deploy, without deploying; lists the files of dist/
bin/stop_local_dev.sh         # remove the container and its volumes, the local D1 included
docker exec gb-dev wrangler d1 execute gb-db --local --command "SELECT ..."
```

Changing dependencies: edit `package.json`, then
`docker run --rm -v "$PWD":/app gb-local npm install --package-lock-only` and `bin/start_local_dev.sh -b`.
