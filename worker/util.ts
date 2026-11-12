// Shared by the ops: the environment, the request context, failures and argument checks.

export interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    JWT_SECRET: string;
}

export type Ctx = { db: D1Database; user: number; now: number };
export type Args = Record<string, any>;
export type Op = (c: Ctx, a: Args) => Promise<unknown>;

// A failure with a message meant for the user.
export class Fail extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}
export const invalid = (message: string) => new Fail(422, message);

// D1 stores epoch ms; the SPA reads RFC3339, and "" for a null timestamp.
export const iso = (ms: number | null | undefined): string => (ms == null ? "" : new Date(ms).toISOString());
