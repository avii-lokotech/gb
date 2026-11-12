-- Logins and what each user keeps per song. Timestamps are epoch milliseconds.

-- A login. There is no sign-up: rows come from bin/cloudflare_add_user.sh (live) and bin/local_add_user.sh.
CREATE TABLE user (
    id            INTEGER PRIMARY KEY,
    email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT    NOT NULL DEFAULT '',
    -- "pbkdf2$<iterations>$<salt b64>$<hash b64>" (PBKDF2-SHA256, 32 bytes), as worker/auth.ts checks it.
    password_hash TEXT    NOT NULL,
    -- Failed logins in a row; ten lock the login until locked_until (worker/auth.ts).
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until  INTEGER,
    disabled_at   INTEGER, -- set: the login is refused
    last_login_at INTEGER,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    CONSTRAINT user_email_len CHECK (length(email) BETWEEN 3 AND 254),
    CONSTRAINT user_name_len CHECK (length(name) <= 100)
);

-- What a user keeps for one song. The songs themselves are files (songs/<Name>.cho with its timing and audio),
-- so a song is known by its path, e.g. 'songs/Madeline.cho'; a row whose file is gone is simply never read.
-- The beat offset (tap to sync) is not here: it belongs to the device playing, and stays in its browser.
CREATE TABLE song_setting (
    user_id        INTEGER NOT NULL REFERENCES user (id) ON DELETE CASCADE,
    song           TEXT    NOT NULL,
    favourite      INTEGER NOT NULL DEFAULT 0,
    speed          REAL    NOT NULL DEFAULT 1, -- playback rate, 1 = 100 %
    loop_from      INTEGER,                    -- the practice loop: first and last bar, counted from 0
    loop_to        INTEGER,
    last_played_at INTEGER,
    updated_at     INTEGER NOT NULL,
    PRIMARY KEY (user_id, song),
    CONSTRAINT song_setting_song_len CHECK (length(song) BETWEEN 1 AND 200),
    CONSTRAINT song_setting_favourite CHECK (favourite IN (0, 1)),
    CONSTRAINT song_setting_speed CHECK (speed BETWEEN 0.25 AND 2),
    CONSTRAINT song_setting_loop CHECK (
        (loop_from IS NULL AND loop_to IS NULL) OR (loop_from >= 0 AND loop_to >= loop_from)
    )
) WITHOUT ROWID;
