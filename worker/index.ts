// gb: serves the site from dist/ (assets) and answers its data calls from D1 (binding DB).
// POST /api/login {email, password} → {token, user}; POST /api/<op> {args} with "Authorization: Bearer <token>".
// Every op runs scoped to the logged-in user. Errors are {"error": "<message for the user>"}.
// The song files (wrangler.jsonc's run_worker_first: /songs/* and the recordings) also come through here and need
// the same token; the SPA itself is served by Cloudflare without reaching the Worker.
import { login, session } from "./auth";
import { Args, Env, Fail, Op } from "./util";
import * as songs from "./ops/songs";

const ops: Record<string, Op> = { ...songs };

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const EXPIRED = "Session expired. Please log in again.";

// A song file, for a logged-in user only. A path with no file would answer the SPA's index.html (the assets'
// single-page-application fallback): that is a 404 here.
async function file(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "Method not allowed." });
    if (!(await session(request, env))) return json(401, { error: EXPIRED });
    const found = await env.ASSETS.fetch(request);
    if (!found.ok || (found.headers.get("Content-Type") ?? "").startsWith("text/html")) {
        return json(404, { error: "Not found." });
    }
    const response = new Response(found.body, found);
    response.headers.set("Cache-Control", "private, no-cache");
    return response;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (!path.startsWith("/api/")) return file(request, env);
        const name = /^\/api\/([A-Za-z]+)$/.exec(path)?.[1];
        if (!name || (name !== "login" && !Object.hasOwn(ops, name))) return json(404, { error: "Not found." });
        if (request.method !== "POST") return json(405, { error: "Method not allowed." });
        try {
            const body: unknown = await request.json().catch(() => null);
            const args: Args = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Args : {};
            if (name === "login") return json(200, await login(env, args.email, args.password));

            const who = await session(request, env);
            if (!who) return json(401, { error: EXPIRED });
            return json(200, await ops[name]({ db: env.DB, user: who.uid, now: Date.now() }, args));
        } catch (e) {
            if (e instanceof Fail) return json(e.status, { error: e.message });
            console.error(e);
            return json(500, { error: "The server failed to complete that. Please try again." });
        }
    },
} satisfies ExportedHandler<Env>;
