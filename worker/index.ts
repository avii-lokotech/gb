// gb: answers the SPA's data calls from D1 (binding DB) and R2 (binding SONGS). The SPA itself is served from
// dist/ by Cloudflare without reaching the Worker; only /api/* does.
//   POST /api/login {email, password} → {token, user}
//   POST /api/<op> {args}             one op of worker/ops/, as JSON
//   POST /api/uploadSong              the body is a recording (worker/ops/songs.ts)
//   GET  /api/audio/<song id>/<track> a track of a song
//   …    /api/converter/…             the converter's side of the queue, with its own token (worker/converter.ts)
// All but login and the converter need "Authorization: Bearer <token>" and run scoped to the logged-in user.
// Errors are {"error": "<message for the user>"}.
import { login, session } from "./auth";
import { converter } from "./converter";
import { Args, Ctx, Env, Fail, Op, id, isTrack, json } from "./util";
import * as songs from "./ops/songs";

const { uploadSong, songAudio, ...jsonOps } = songs;
const ops: Record<string, Op> = jsonOps;

async function route(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/converter/")) return converter(request, env, path.slice("/api/converter/".length));

    const audio = /^\/api\/audio\/(\d+)\/([a-z]+)$/.exec(path);
    const name = /^\/api\/([A-Za-z]+)$/.exec(path)?.[1];
    if (!audio && (!name || (name !== "login" && name !== "uploadSong" && !Object.hasOwn(ops, name)))) {
        return json(404, { error: "Not found." });
    }
    if (request.method !== (audio ? "GET" : "POST")) return json(405, { error: "Method not allowed." });

    if (name === "login") {
        const body: any = await request.json().catch(() => null);
        return json(200, await login(env, body?.email, body?.password));
    }

    const who = await session(request, env);
    if (!who) return json(401, { error: "Session expired. Please log in again." });
    const c: Ctx = { db: env.DB, bucket: env.SONGS, user: who.uid, now: Date.now() };

    if (audio) {
        const song = id(audio[1]);
        return song !== null && isTrack(audio[2]) ? songAudio(c, song, audio[2]) : json(404, { error: "Not found." });
    }
    if (name === "uploadSong") return json(200, await uploadSong(c, request));

    const body: unknown = await request.json().catch(() => null);
    const args: Args = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Args : {};
    return json(200, await ops[name!](c, args));
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        try {
            return await route(request, env);
        } catch (e) {
            if (e instanceof Fail) return json(e.status, { error: e.message });
            console.error(e);
            return json(500, { error: "The server failed to complete that. Please try again." });
        }
    },
} satisfies ExportedHandler<Env>;
