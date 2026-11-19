-- Foods the user has eaten, one row per (user, food), mirrored into the Vectorize index HISTORY
-- for search by meaning ("those chicken meatballs I like"). `text` is what was embedded.
CREATE TABLE history_entry (
  user_id     TEXT NOT NULL REFERENCES users(id),
  food_id     TEXT NOT NULL REFERENCES food(id),
  vector_id   TEXT NOT NULL,
  text        TEXT NOT NULL,
  names_json  TEXT NOT NULL DEFAULT '[]',   -- the user's own wordings, most used first
  times       INTEGER NOT NULL,
  last_at     TEXT NOT NULL,
  indexed_at  TEXT,                         -- NULL until the vector is stored
  PRIMARY KEY (user_id, food_id)
);
CREATE UNIQUE INDEX history_vector ON history_entry (vector_id);
