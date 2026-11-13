# gb

The guitar book at **https://www.gb-songs.com**: one Cloudflare Worker (`gb`, `wrangler.jsonc`) that serves a Vue 3 +
Vite SPA from `dist/` and keeps each user's songs in the D1 database `gb-db` (binding `DB`) and the R2 bucket
`gb-songs` (binding `SONGS`).

A user uploads a recording on the site. The **converter**, `tools/song2cho/converter.py` on a Mac that can run
song2cho, picks it up, works out its chords, lyrics and timing, and hands them back; the song then opens in the
player. Songs are not in this repo.

- `src/` — the SPA: login, the songs with the upload (`views/SongsView.vue`), the player (`views/PlayerView.vue`
  with `components/SongSheet.vue`; parsing and layout in `lib/song.js`) and the beats page (`views/BeatsView.vue`:
  only a player and the song bar by bar, each beat with the words that start there as plain text). All network calls go through `src/lib/api.js`.
  Styling is Tailwind 4 (the `@tailwindcss/vite` plugin; no config file): utility classes in the templates, on
  Tailwind's own scale (rem) with the site's colours as the `@theme` of `src/style.css`. The pages are written
  mobile-first: unprefixed classes are the phone layout, and `sm:` / `md:` / `lg:` / `xl:` add to it (the sheet
  shows two bars per line on a phone and four from `sm:`, with the lyric line beside its bars from `xl:`). No
  arbitrary values, no `@apply`, no named classes: what repeats is a component (`components/AppButton.vue`, with
  `variant`, `size` and `on` props, and `components/AppNotice.vue`).
- `worker/` — the Worker; only `/api/*` reaches it. `POST /api/login` returns a JWT; `POST /api/<op>` runs one op
  (`worker/ops/`) for the logged-in user; `POST /api/uploadSong` and `GET /api/audio/<id>/<track>` carry the audio;
  `/api/converter/*` is the converter's side of the queue, with its own token (`worker/converter.ts`).
- `migrations/` — the D1 schema: `user` (the logins) and `song` (per user: title, artist, the ChordPro text in use
  and as converted, the conversion's status, and the user's favourite, speed, practice loop and last played).
- R2 holds the audio: `songs/<user id>/<song id>/source` (the upload), `instrumental.mp3` and `rhythm.mp3`.
- `tools/song2cho/` — the conversion (Demucs, beat_this, chords, Whisper; Apple GPU) and the converter around it.
- `tools/player/` — the original single-file player, for song2cho's own output in `songs/` (git-ignored) without
  the site (`tools/player/serve.sh`). The site's player is the Vue port of it.

## Deploy

Workers Builds deploys every push to `main` (connect the repository once in the Cloudflare dashboard):

| Setting | Value |
|---|---|
| Repository / branch / root | `avii-lokotech/gb`, `main`, `/` |
| Build command | none (`npm ci` runs anyway) |
| Deploy command | `npx wrangler d1 migrations apply gb-db --remote && npx wrangler deploy`: the pending migrations, then the deploy, which runs `wrangler.jsonc`'s build command (`npm run build`: the site into `dist/` + Worker typecheck) |
| Project name | `gb`, the `name` in `wrangler.jsonc` |
| API token | Account → Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Account Settings Read; Zone `gb-songs.com` → Workers Routes Edit (the Custom Domain) |

The D1 database is `gb-db`, `database_id` `4b86277f-935a-4936-8558-6366d355e2b3` in `wrangler.jsonc`.

Once, before the first deploy:

1. The zone `gb-songs.com` must be active in the Cloudflare account. The deploy then creates the DNS record and
   certificate of `www.gb-songs.com` itself; there is no `workers.dev` URL.
2. Create the R2 bucket `gb-songs` (dashboard → Storage & Databases → R2; R2 must be enabled on the account). A
   deploy that binds a bucket that does not exist fails.
3. Set the secrets (dashboard → Worker → Settings → Variables and Secrets, type Secret, or `wrangler secret put`),
   each a long random value (`openssl rand -hex 32`):
   - `JWT_SECRET` signs the sessions. Without it (or under 16 characters) every login is refused. Changing it logs
     everyone out.
   - `CONVERTER_TOKEN` lets the converter in. Without it (or under 16 characters) no converter is accepted and
     uploaded songs wait.

## Converter

Uploaded songs wait until a converter takes them. Run it on the Mac that has song2cho's environment
(`tools/song2cho/.venv`):

```bash
GB_CONVERTER_TOKEN=<the CONVERTER_TOKEN secret> python3 tools/song2cho/converter.py   # -h for the options
```

It asks the site every 15 seconds for the oldest waiting song of any user, converts it (a few minutes), uploads the
results and asks again; stop it with Ctrl-C. A finished song has **Convert again** on the site, which puts it back
in the queue; the new conversion replaces its text, edits included. A song that fails shows the reason, with **Try again**; the
full output stays in `tools/song2cho/work/queue/job-<id>.log`. A song claimed and not finished within 30 minutes is
handed out again. Whoever has the token can read every uploaded recording and write any song's result, so it stays
on that Mac.

## The song's text and its timing

A song is one ChordPro text, and the text holds the timing too, so what is played and when is said in one place.
Three directives of our own carry it (ChordPro leaves `x_…` to extensions, and other ChordPro tools skip them),
with every time in whole milliseconds from the start of the recording:

```
{start_of_grid label="Verse 2"}
{x_bars: 26160 28720 31320 33900}
| G . . . | C . . . | G . . . | C . . . |
{end_of_grid}
{start_of_verse label="Verse 2"}
{x_line: 26400 31100}
{x_words: 26400 27300 28100 28720 29400 30100}
[G]Homeward bound I wish I [C]was
{end_of_verse}
{x_end: 140940}
```

- `{x_bars: …}` before a grid row: when each bar of that row starts.
- `{x_line: start end}` before a lyric line: when it is sung.
- `{x_words: …}` after it, optional: when each word of that line starts. The beats page uses it to show a word
  in the bars it is sung in; a line without it, or with other words than times (after an edit), has its words
  spread evenly over the line's length.
- `{x_end: …}` once: when the last bar ends.

A bar has as many beats as it has cells (`| . . |` is a two-beat bar), evenly spaced from its start to the next
bar's start. The converter writes all of it; the player (`src/lib/song.js`) reads nothing else.

**Edit** in the player opens the text under the sheet, which follows what is typed; the player keeps working, so a
bar can be looped while it is corrected. Chords, words, bars and lines can all be changed, added or removed: a new
grid row needs its `{x_bars}`, a new lyric line its `{x_line}`, and the sheet says which one is missing or out of
order. Save stores the text (title and artist follow its `{title: …}` and `{artist: …}`); **Converted draft**
brings back what the conversion made.

Songs converted before this have their timing apart, in `song.sync`. The player writes it into the text when it
opens such a song (`withTiming`), and it is stored that way the next time the text is saved or the song converted
again; `song.sync` is then no longer read.

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
applies it to the live D1, `bin/start_local_dev.sh` to the local one. The player's beat offset (tap to sync) is not
in the database: it belongs to the device playing and stays in its browser.

Add an op as an exported function in `worker/ops/` and a method on `api` in `src/lib/api.js`. Every op gets the
logged-in user's id and must scope its queries, and its R2 keys (`objectKey` in `worker/util.ts`), by it.

Deleting a song deletes its row and its objects. A `user` row with songs cannot be deleted (the foreign key
refuses): delete the songs on the site first, or set `disabled_at`.

## Local development

Everything runs in Docker; nothing is installed on the host.

```bash
bin/start_local_dev.sh [-b]   # migrations, then wrangler dev on http://127.0.0.1:8791 (build at start and on every change), local D1 and R2
t/local_seed.sh               # the test login of the local D1; email and password in its -h
bin/local_add_user.sh -e EMAIL [-n NAME]   # another local login
bin/dry_run.sh [-b]           # what a push would deploy, without deploying; lists the files of dist/
bin/stop_local_dev.sh         # remove the container and its volumes, the local D1 and R2 included
GB_CONVERTER_TOKEN=local-dev-only-converter-token python3 tools/song2cho/converter.py --url http://127.0.0.1:8791   # the local converter
docker exec gb-dev wrangler d1 execute gb-db --local --command "SELECT ..."
```

Changing dependencies: edit `package.json`, then
`docker run --rm -v "$PWD":/app gb-local npm install --package-lock-only` and `bin/start_local_dev.sh -b`.
