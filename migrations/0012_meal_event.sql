-- A versioned log of every change to a meal and its items: what the AI logged (with the model,
-- prompt, query and candidates), answers to its questions, searches for a different food, swaps,
-- amount changes, adds, removals and deletes. Append-only; before/after hold item snapshots.
-- No foreign key on intake_id: drafts merged into another meal are deleted, their events stay.
CREATE TABLE meal_event (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  intake_id    TEXT NOT NULL,
  item_id      TEXT,
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor        TEXT NOT NULL CHECK (actor IN ('app', 'mcp', 'ai', 'system')),
  kind         TEXT NOT NULL,
  before_json  TEXT,
  after_json   TEXT,
  detail_json  TEXT
);
CREATE INDEX meal_event_intake ON meal_event (intake_id, at);
CREATE INDEX meal_event_item ON meal_event (item_id);
CREATE INDEX meal_event_user ON meal_event (user_id, at);
