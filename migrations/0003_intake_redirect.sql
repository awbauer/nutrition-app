-- When an AI-logged entry is merged into an existing meal, its draft row is removed.
-- Keep a pointer so clients still holding the draft id can follow it to the meal. Additive.
CREATE TABLE intake_redirect (
  user_id     TEXT NOT NULL REFERENCES users(id),
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, from_id)
);
