// The logged-in user's songs (table song, and their audio in the bucket). Every query is scoped by user_id:
// another user's song answers "not found".
import { Args, Ctx, Fail, MAX_AUDIO_BYTES, MAX_CHO_CHARS, Track, audio, directive, id, invalid, iso, json, notFound, objectKey } from "../util";

type Row = {
    id: number;
    title: string;
    artist: string;
    status: string;
    error: string;
    cho: string | null;
    cho_draft: string | null;
    sync: string | null;
    has_instrumental: number;
    has_rhythm: number;
    favourite: number;
    speed: number;
    loop_from: number | null;
    loop_to: number | null;
    last_played_at: number | null;
    created_at: number;
};

const LIST = "id, title, artist, status, error, has_instrumental, has_rhythm, favourite, speed, loop_from, loop_to, last_played_at, created_at";

// status: uploaded (waiting for the converter), converting, ready, or failed with error.
// loop is [first bar, last bar], counted from 0, or null for none.
const shape = (r: Omit<Row, "cho" | "cho_draft" | "sync">) => ({
    id: r.id,
    title: r.title,
    artist: r.artist,
    status: r.status,
    error: r.error,
    tracks: { instrumental: r.has_instrumental === 1, rhythm: r.has_rhythm === 1 },
    favourite: r.favourite === 1,
    speed: r.speed,
    loop: r.loop_from === null || r.loop_to === null ? null : [r.loop_from, r.loop_to],
    last_played_at: iso(r.last_played_at),
    created_at: iso(r.created_at),
});

function songId(a: Args): number {
    const v = id(a.id);
    if (v === null) throw invalid("id must be a song's id.");
    return v;
}

async function find(c: Ctx, song: number, columns = LIST): Promise<Row> {
    const row = await c.db.prepare(`SELECT ${columns} FROM song WHERE id = ?1 AND user_id = ?2`).bind(song, c.user).first<Row>();
    if (!row) throw notFound("Song");
    return row;
}

// → { songs: [...] } without the ChordPro text and timing, by title.
export async function listSongs(c: Ctx) {
    const { results } = await c.db.prepare(`SELECT ${LIST} FROM song WHERE user_id = ?1 ORDER BY title COLLATE NOCASE, id`)
        .bind(c.user).all<Row>();
    return { songs: results.map(shape) };
}

// { id } → the song with cho (the ChordPro text in use), draft (the text the conversion made, before any edit)
// and sync (the timing: { beats, bars, lines }); all null until converted, sync also when the conversion made none.
export async function getSong(c: Ctx, a: Args) {
    const row = await find(c, songId(a), `${LIST}, cho, cho_draft, sync`);
    return { ...shape(row), cho: row.cho, draft: row.cho_draft, sync: row.sync === null ? null : JSON.parse(row.sync) };
}

// { id, cho }: the user's edit of a converted song's text. Title and artist follow its {title: …} and
// {artist: …}. The draft and the timing stay. → the song.
export async function saveSongText(c: Ctx, a: Args) {
    const row = await find(c, songId(a));
    if (row.status !== "ready") throw new Fail(409, "Only a converted song can be edited.");
    const cho = a.cho;
    if (typeof cho !== "string" || !cho.trim()) throw invalid("The song's text is empty.");
    if (cho.length > MAX_CHO_CHARS) throw invalid("The song's text is too long.");
    row.title = directive(cho, "title") || row.title;
    row.artist = directive(cho, "artist");
    await c.db.prepare("UPDATE song SET cho = ?3, title = ?4, artist = ?5, updated_at = ?6 WHERE id = ?1 AND user_id = ?2")
        .bind(row.id, c.user, cho, row.title, row.artist, c.now).run();
    return shape(row);
}

// { id, favourite?, speed?, loop?, played? } → the song after the change. Omitted is unchanged; loop null clears
// the loop; played true stamps last_played_at.
export async function saveSongSetting(c: Ctx, a: Args) {
    const row = await find(c, songId(a));
    if (a.favourite !== undefined) {
        if (typeof a.favourite !== "boolean") throw invalid("favourite must be true or false.");
        row.favourite = a.favourite ? 1 : 0;
    }
    if (a.speed !== undefined) {
        if (typeof a.speed !== "number" || !(a.speed >= 0.25 && a.speed <= 2)) throw invalid("speed must be between 0.25 and 2.");
        row.speed = a.speed;
    }
    if (a.loop !== undefined) {
        if (a.loop === null) {
            row.loop_from = row.loop_to = null;
        } else {
            const [from, to] = Array.isArray(a.loop) && a.loop.length === 2 ? a.loop : [];
            if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) {
                throw invalid("loop must be [first bar, last bar] or null.");
            }
            row.loop_from = from;
            row.loop_to = to;
        }
    }
    if (a.played === true) row.last_played_at = c.now;
    await c.db.prepare(
        `UPDATE song SET favourite = ?3, speed = ?4, loop_from = ?5, loop_to = ?6, last_played_at = ?7, updated_at = ?8
         WHERE id = ?1 AND user_id = ?2`,
    ).bind(row.id, c.user, row.favourite, row.speed, row.loop_from, row.loop_to, row.last_played_at, c.now).run();
    return shape(row);
}

// { id }: back in the queue: a failed conversion to try again, or a finished song to convert again. A finished
// song keeps its text and tracks until the new conversion is done, which then replaces them, the user's edits of
// the text included. Its settings stay.
export async function retrySong(c: Ctx, a: Args) {
    const row = await find(c, songId(a));
    if (row.status !== "failed" && row.status !== "ready") throw new Fail(409, "This song is already waiting to be converted.");
    await c.db.prepare("UPDATE song SET status = 'uploaded', error = '', claimed_at = NULL, updated_at = ?3 WHERE id = ?1 AND user_id = ?2")
        .bind(row.id, c.user, c.now).run();
    return shape({ ...row, status: "uploaded", error: "" });
}

// { id }: the song and its audio, for good. The row first: a converter still working on it then finds it gone.
export async function deleteSong(c: Ctx, a: Args) {
    const row = await find(c, songId(a));
    await c.db.prepare("DELETE FROM song WHERE id = ?1 AND user_id = ?2").bind(row.id, c.user).run();
    await c.bucket.delete((["mix", "instrumental", "rhythm"] as Track[]).map((t) => objectKey(c.user, row.id, t)));
    return { deleted: row.id };
}

// POST /api/uploadSong: the body is the recording, X-File-Name its name (URI-encoded). → the new song, waiting
// for the converter.
export async function uploadSong(c: Ctx, request: Request) {
    let name = "";
    try {
        name = decodeURIComponent(request.headers.get("X-File-Name") ?? "").split(/[\\/]/).pop()!.trim().slice(0, 200);
    } catch { /* not URI-encoded: no name */ }
    const type = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
    if (!type.startsWith("audio/") && !/\.(mp3|m4a|wav|flac|ogg|aac)$/i.test(name)) {
        throw invalid("That is not an audio file (mp3, m4a, wav, flac, ogg or aac).");
    }
    const tooLarge = new Fail(413, `The file is too large: at most ${MAX_AUDIO_BYTES / 1024 / 1024} MB.`);
    if (Number(request.headers.get("Content-Length") ?? 0) > MAX_AUDIO_BYTES) throw tooLarge;
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_AUDIO_BYTES) throw tooLarge;
    if (!body.byteLength) throw invalid("The file is empty.");

    const title = name.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim() || "Untitled";
    const contentType = type.startsWith("audio/") ? type : "application/octet-stream";
    const row = await c.db.prepare(
        `INSERT INTO song (user_id, title, file_name, content_type, size, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) RETURNING ${LIST}`,
    ).bind(c.user, title, name || "upload", contentType, body.byteLength, c.now).first<Row>();
    try {
        await c.bucket.put(objectKey(c.user, row!.id, "mix"), body, { httpMetadata: { contentType } });
    } catch (e) {
        await c.db.prepare("DELETE FROM song WHERE id = ?1").bind(row!.id).run();
        throw e;
    }
    return shape(row!);
}

// GET /api/audio/<song id>/<mix|instrumental|rhythm>: one track of the user's song.
export async function songAudio(c: Ctx, song: number, track: Track): Promise<Response> {
    await find(c, song, "id");
    const object = await c.bucket.get(objectKey(c.user, song, track));
    return object ? audio(object) : json(404, { error: "Not found." });
}

