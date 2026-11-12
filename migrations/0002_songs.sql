-- Songs move from files in the repo to the database: a song belongs to the user who uploaded its recording.
-- The recording and the tracks made from it are objects in the R2 bucket (binding SONGS), named
-- songs/<user id>/<song id>/source, instrumental.mp3 and rhythm.mp3; the ChordPro text and the timing are here.
-- What a user keeps for a song (favourite, speed, loop, last played) is now columns of the song itself, so
-- song_setting, keyed on a file path, goes; its rows are not carried over.
DROP TABLE song_setting;

CREATE TABLE song (
    -- AUTOINCREMENT: an id is never used again, so the R2 objects of a deleted song can never become another's.
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL REFERENCES user (id),
    title            TEXT    NOT NULL, -- the upload's file name until converted, then the {title: …} of cho
    artist           TEXT    NOT NULL DEFAULT '',
    -- The uploaded recording.
    file_name        TEXT    NOT NULL,
    content_type     TEXT    NOT NULL,
    size             INTEGER NOT NULL,
    -- The conversion (worker/converter.ts): uploaded → converting (claimed by the converter at claimed_at) →
    -- ready, or failed with error, a sentence for the user.
    status           TEXT    NOT NULL DEFAULT 'uploaded',
    error            TEXT    NOT NULL DEFAULT '',
    claimed_at       INTEGER,
    -- What the conversion made: the ChordPro text, the timing as JSON ({beats, bars, lines}), and which tracks.
    cho              TEXT,
    sync             TEXT,
    has_instrumental INTEGER NOT NULL DEFAULT 0,
    has_rhythm       INTEGER NOT NULL DEFAULT 0,
    -- The user's settings. The beat offset (tap to sync) is not here: it belongs to the device playing.
    favourite        INTEGER NOT NULL DEFAULT 0,
    speed            REAL    NOT NULL DEFAULT 1, -- playback rate, 1 = 100 %
    loop_from        INTEGER,                    -- the practice loop: first and last bar, counted from 0
    loop_to          INTEGER,
    last_played_at   INTEGER,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    CONSTRAINT song_title_len CHECK (length(title) BETWEEN 1 AND 200),
    CONSTRAINT song_artist_len CHECK (length(artist) <= 200),
    CONSTRAINT song_status CHECK (status IN ('uploaded', 'converting', 'ready', 'failed')),
    CONSTRAINT song_ready CHECK (status <> 'ready' OR cho IS NOT NULL),
    CONSTRAINT song_flags CHECK (has_instrumental IN (0, 1) AND has_rhythm IN (0, 1) AND favourite IN (0, 1)),
    CONSTRAINT song_speed CHECK (speed BETWEEN 0.25 AND 2),
    CONSTRAINT song_loop CHECK (
        (loop_from IS NULL AND loop_to IS NULL) OR (loop_from >= 0 AND loop_to >= loop_from)
    )
);

CREATE INDEX song_user ON song (user_id);
-- The converter's queue: the oldest song that is waiting.
CREATE INDEX song_queue ON song (status, created_at);
