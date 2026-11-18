-- Deleting a custom food archives it: past logs still point at the row, but it's no longer offered.
ALTER TABLE food ADD COLUMN archived_at TEXT;
