// Login against the user table and stateless JWT (HS256) sessions, all on WebCrypto.
import { Env, Fail } from "./util";

const TOKEN_TTL_S = 7 * 24 * 3600;
const MAX_FAILED_LOGINS = 10;
const LOCK_MS = 15 * 60 * 1000;
const enc = new TextEncoder();

const toB64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const b64url = (bytes: Uint8Array): string => toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string): Uint8Array =>
    Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

// Without the secret (not yet set with wrangler secret put JWT_SECRET) nothing is signed or accepted: encoding an
// undefined secret would sign every token with the well-known key "undefined".
function hmacKey(secret: string | undefined): Promise<CryptoKey> {
    if (!secret || secret.length < 16) throw new Error("JWT_SECRET is not set (or shorter than 16 characters)");
    return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export type Session = { uid: number };

async function issue(env: Env, session: Session): Promise<string> {
    const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
    const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
    const body = b64url(enc.encode(JSON.stringify({ ...session, exp })));
    const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.JWT_SECRET), enc.encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

// The session from "Authorization: Bearer <jwt>", or null when missing, forged or expired. Stateless: a token
// stays good until it expires, also after its user is disabled.
export async function session(request: Request, env: Env): Promise<Session | null> {
    const token = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
    const [head, body, sig] = token?.split(".") ?? [];
    if (!head || !body || !sig) return null;
    try {
        const ok = await crypto.subtle.verify("HMAC", await hmacKey(env.JWT_SECRET), fromB64url(sig), enc.encode(`${head}.${body}`));
        if (!ok) return null;
        const claims = JSON.parse(new TextDecoder().decode(fromB64url(body)));
        if (!(claims.uid > 0) || !(claims.exp > Date.now() / 1000)) return null;
        return { uid: claims.uid };
    } catch {
        return null;
    }
}

// password_hash is "pbkdf2$<iterations>$<salt b64>$<hash b64>" (PBKDF2-SHA256, 32 bytes), as bin/local_add_user.sh
// and bin/cloudflare_add_user.sh write it.
async function checkPassword(stored: string | null, password: string): Promise<boolean> {
    const [scheme, iter, salt, hash] = (stored ?? "pbkdf2$100000$AAAA$AAAA").split("$");
    if (scheme !== "pbkdf2") return false;
    const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt: fromB64(salt), iterations: Number(iter) }, key, 256));
    const want = fromB64(hash);
    let diff = bits.length ^ want.length;
    for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ (want[i] ?? 0);
    return stored !== null && diff === 0;
}

type UserRow = {
    id: number;
    email: string;
    name: string;
    password_hash: string;
    locked_until: number | null;
    disabled_at: number | null;
};

// Ten failures in a row lock the login for 15 minutes; the count starts again after a lock.
export async function login(env: Env, email: unknown, password: unknown): Promise<unknown> {
    const denied = new Fail(401, "Invalid email or password.");
    if (typeof email !== "string" || typeof password !== "string") throw denied;
    const user = await env.DB.prepare(
        "SELECT id, email, name, password_hash, locked_until, disabled_at FROM user WHERE email = ?1",
    ).bind(email.trim()).first<UserRow>();
    // Hashed even for an unknown email, so the response time does not tell which emails exist.
    const ok = await checkPassword(user?.password_hash ?? null, password);
    if (!user || user.disabled_at !== null) throw denied;
    const now = Date.now();
    if (user.locked_until !== null && user.locked_until > now) throw new Fail(401, "Too many failed logins. Try again in 15 minutes.");
    if (!ok) {
        await env.DB.prepare(
            `UPDATE user SET
                 failed_logins = CASE WHEN locked_until IS NOT NULL THEN 1 ELSE failed_logins + 1 END,
                 locked_until = CASE WHEN locked_until IS NULL AND failed_logins + 1 >= ?2 THEN ?3 END
             WHERE id = ?1`,
        ).bind(user.id, MAX_FAILED_LOGINS, now + LOCK_MS).run();
        throw denied;
    }
    await env.DB.prepare("UPDATE user SET failed_logins = 0, locked_until = NULL, last_login_at = ?2 WHERE id = ?1")
        .bind(user.id, now).run();
    return {
        token: await issue(env, { uid: user.id }),
        user: { id: user.id, email: user.email, name: user.name },
    };
}
