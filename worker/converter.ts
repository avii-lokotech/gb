// The converter's side of the queue: /api/converter/*, with "Authorization: Bearer <CONVERTER_TOKEN>".
// The converter (tools/song2cho/converter.py, on a machine that can run song2cho) is not a user: it takes the
// oldest waiting song of any user, makes its ChordPro text, timing and tracks, and hands them back.
//   POST /api/converter/claim                       → { job: { id, title, file_name } } (now converting), or { job: null }
//   GET  /api/converter/source/<id>                 → the uploaded recording
//   PUT  /api/converter/track/<id>/<instrumental|rhythm>   body: the track, an mp3
//   POST /api/converter/done/<id>   { cho, sync }   → ready; title and artist are taken from cho
//   POST /api/converter/fail/<id>   { error }       → failed, with a sentence for the user
// A song claimed and not finished within STALE_MS is handed out again. A song deleted meanwhile answers 404.
import { Env, Fail, MAX_AUDIO_BYTES, audio, id, invalid, isTrack, json, notFound, objectKey } from "./util";

const STALE_MS = 30 * 60 * 1000;
const MAX_CHO_CHARS = 500_000;
const MAX_SYNC_CHARS = 1_500_000;

// Without the secret (not yet set with wrangler secret put CONVERTER_TOKEN) no converter is accepted.
function allowed(request: Request, env: Env): boolean {
    const want = env.CONVERTER_TOKEN;
    const got = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1] ?? "";
    if (!want || want.length < 16 || got.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
    return diff === 0;
}

type Job = { id: number; user_id: number; title: string; file_name: string };

// The song a converter is working on.
async function claimed(env: Env, song: number): Promise<Job> {
    const job = await env.DB.prepare("SELECT id, user_id, title, file_name FROM song WHERE id = ?1 AND status = 'converting'")
        .bind(song).first<Job>();
    if (!job) throw notFound("Job");
    return job;
}

const directive = (cho: string, name: string): string =>
    new RegExp(`^\\s*\\{${name}:\\s*(.*?)\\s*\\}\\s*$`, "m").exec(cho)?.[1].slice(0, 200) ?? "";

export async function converter(request: Request, env: Env, path: string): Promise<Response> {
    if (!allowed(request, env)) return json(401, { error: "Converter token missing or wrong." });
    const [action, songArg, trackArg] = path.split("/");
    const now = Date.now();
    const route = `${request.method} ${action}`;

    if (route === "POST claim") {
        const job = await env.DB.prepare(
            `UPDATE song SET status = 'converting', claimed_at = ?1, error = '', updated_at = ?1
             WHERE id = (SELECT id FROM song WHERE status = 'uploaded' OR (status = 'converting' AND claimed_at < ?2)
                         ORDER BY created_at, id LIMIT 1)
             RETURNING id, title, file_name`,
        ).bind(now, now - STALE_MS).first<Omit<Job, "user_id">>();
        return json(200, { job: job ?? null });
    }

    const song = id(songArg);
    if (song === null) return json(404, { error: "Not found." });

    if (route === "GET source") {
        const job = await claimed(env, song);
        const object = await env.SONGS.get(objectKey(job.user_id, song, "mix"));
        if (!object) throw notFound("Recording");
        return audio(object);
    }

    if (route === "PUT track") {
        if (!trackArg || !isTrack(trackArg) || trackArg === "mix") return json(404, { error: "Not found." });
        const job = await claimed(env, song);
        const body = await request.arrayBuffer();
        if (!body.byteLength || body.byteLength > MAX_AUDIO_BYTES) throw new Fail(413, "The track is empty or too large.");
        await env.SONGS.put(objectKey(job.user_id, song, trackArg), body, { httpMetadata: { contentType: "audio/mpeg" } });
        // The song may have been deleted while the track was on its way: do not leave the object behind.
        if (!(await env.DB.prepare("SELECT 1 FROM song WHERE id = ?1").bind(song).first())) {
            await env.SONGS.delete(objectKey(job.user_id, song, trackArg));
            throw notFound("Job");
        }
        return json(200, { stored: trackArg });
    }

    const body: any = await request.json().catch(() => null);

    if (route === "POST done") {
        const job = await claimed(env, song);
        const cho = body?.cho, sync = body?.sync ?? null;
        if (typeof cho !== "string" || !cho.trim() || cho.length > MAX_CHO_CHARS) throw invalid("cho must be the ChordPro text.");
        const syncText = sync === null ? null : JSON.stringify(sync);
        if (sync !== null && (!Array.isArray(sync.beats) || !Array.isArray(sync.bars) || !Array.isArray(sync.lines) ||
            syncText!.length > MAX_SYNC_CHARS)) {
            throw invalid("sync must be { beats, bars, lines } or null.");
        }
        const [instrumental, rhythm] = await Promise.all([
            env.SONGS.head(objectKey(job.user_id, song, "instrumental")),
            env.SONGS.head(objectKey(job.user_id, song, "rhythm")),
        ]);
        const done = await env.DB.prepare(
            `UPDATE song SET status = 'ready', error = '', cho = ?2, sync = ?3, title = ?4, artist = ?5,
                 has_instrumental = ?6, has_rhythm = ?7, updated_at = ?8
             WHERE id = ?1 AND status = 'converting' RETURNING id`,
        ).bind(song, cho, syncText, directive(cho, "title") || job.title, directive(cho, "artist"),
            instrumental ? 1 : 0, rhythm ? 1 : 0, now).first();
        if (!done) throw notFound("Job");
        return json(200, { status: "ready" });
    }

    if (route === "POST fail") {
        await claimed(env, song);
        const error = (typeof body?.error === "string" && body.error.trim() ? body.error.trim() : "The conversion failed.").slice(0, 500);
        await env.DB.prepare("UPDATE song SET status = 'failed', error = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'converting'")
            .bind(song, error, now).run();
        return json(200, { status: "failed" });
    }

    return json(404, { error: "Not found." });
}
