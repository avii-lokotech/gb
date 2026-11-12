// What the logged-in user keeps per song (table song_setting). A song is its path, e.g. "songs/Madeline.cho".
import { Args, Ctx, invalid, iso } from "../util";

type Row = {
    song: string;
    favourite: number;
    speed: number;
    loop_from: number | null;
    loop_to: number | null;
    last_played_at: number | null;
};

const COLUMNS = "song, favourite, speed, loop_from, loop_to, last_played_at";
const DEFAULTS = { favourite: 0, speed: 1, loop_from: null, loop_to: null, last_played_at: null };

// One file directly in songs/: no further "/" and no "..", so it cannot name anything else.
function songPath(a: Args): string {
    const v = a.song;
    if (typeof v !== "string" || v.length > 200 || !/^songs\/[^/\\]+\.cho$/.test(v) || v.includes("..")) {
        throw invalid("song must be a path like songs/Name.cho.");
    }
    return v;
}

// loop is [first bar, last bar], counted from 0, or null for none.
const shape = (r: Row) => ({
    song: r.song,
    favourite: r.favourite === 1,
    speed: r.speed,
    loop: r.loop_from === null || r.loop_to === null ? null : [r.loop_from, r.loop_to],
    last_played_at: iso(r.last_played_at),
});

const find = (c: Ctx, song: string) =>
    c.db.prepare(`SELECT ${COLUMNS} FROM song_setting WHERE user_id = ?1 AND song = ?2`).bind(c.user, song).first<Row>();

// → { settings: [{ song, favourite, speed, loop, last_played_at }] }: only the songs the user has touched.
export async function listSongSettings(c: Ctx) {
    const { results } = await c.db.prepare(`SELECT ${COLUMNS} FROM song_setting WHERE user_id = ?1 ORDER BY song`)
        .bind(c.user).all<Row>();
    return { settings: results.map(shape) };
}

// { song } → its setting; the defaults for a song the user has not touched.
export async function getSongSetting(c: Ctx, a: Args) {
    const song = songPath(a);
    return shape((await find(c, song)) ?? { song, ...DEFAULTS });
}

// { song, favourite?, speed?, loop?, played? } → the setting after the change. Omitted is unchanged; loop null
// clears the loop; played true stamps last_played_at.
export async function saveSongSetting(c: Ctx, a: Args) {
    const song = songPath(a);
    const row: Row = (await find(c, song)) ?? { song, ...DEFAULTS };
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
        `INSERT INTO song_setting (user_id, song, favourite, speed, loop_from, loop_to, last_played_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (user_id, song) DO UPDATE SET favourite = excluded.favourite, speed = excluded.speed,
             loop_from = excluded.loop_from, loop_to = excluded.loop_to, last_played_at = excluded.last_played_at,
             updated_at = excluded.updated_at`,
    ).bind(c.user, song, row.favourite, row.speed, row.loop_from, row.loop_to, row.last_played_at, c.now).run();
    return shape(row);
}
