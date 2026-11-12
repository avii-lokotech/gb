-- The song's text can be edited on the site: cho is the text in use, cho_draft what the conversion made, kept so
-- an edit can be undone. Songs converted before this have their text as their draft.
ALTER TABLE song ADD COLUMN cho_draft TEXT;
UPDATE song SET cho_draft = cho;
