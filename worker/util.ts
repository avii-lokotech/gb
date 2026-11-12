// Shared by the ops: the environment, the request context, failures and what names a song's objects.

export interface Env {
    DB: D1Database;
    SONGS: R2Bucket;
    JWT_SECRET: string;
    CONVERTER_TOKEN: string;
}

export type Ctx = { db: D1Database; bucket: R2Bucket; user: number; now: number };
export type Args = Record<string, any>;
export type Op = (c: Ctx, a: Args) => Promise<unknown>;

// A failure with a message meant for the user.
export class Fail extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}
export const invalid = (message: string) => new Fail(422, message);
export const notFound = (what: string) => new Fail(404, `${what} not found.`);

export const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// D1 stores epoch ms; the SPA reads RFC3339, and "" for a null timestamp.
export const iso = (ms: number | null | undefined): string => (ms == null ? "" : new Date(ms).toISOString());

// A song's objects in the bucket: the uploaded recording (the full mix) and the tracks the conversion makes.
export const TRACKS = { mix: "source", instrumental: "instrumental.mp3", rhythm: "rhythm.mp3" } as const;
export type Track = keyof typeof TRACKS;
export const isTrack = (v: string): v is Track => Object.hasOwn(TRACKS, v);
export const objectKey = (user: number, song: number, track: Track) => `songs/${user}/${song}/${TRACKS[track]}`;

// The largest ChordPro text taken, and the value of its {name: …} directive ("" when it has none).
export const MAX_CHO_CHARS = 500_000;
export const directive = (cho: string, name: string): string =>
    new RegExp(`^\\s*\\{${name}:\\s*(.*?)\\s*\\}\\s*$`, "m").exec(cho)?.[1].slice(0, 200) ?? "";

// The largest recording taken, and the largest track the converter may send back.
export const MAX_AUDIO_BYTES = 40 * 1024 * 1024;

// A positive whole number from a path segment or an argument, or null.
export function id(v: unknown): number | null {
    const n = typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : v;
    return Number.isSafeInteger(n) && (n as number) > 0 ? (n as number) : null;
}

// An object of the bucket as a response for its owner.
export function audio(object: R2ObjectBody): Response {
    const headers = new Headers({ "Cache-Control": "private, no-cache", ETag: object.httpEtag });
    object.writeHttpMetadata(headers);
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Length", String(object.size));
    return new Response(object.body, { headers });
}
