-- Additive only (old clients may still be running during a deploy).

-- How each AI-logged item was matched: the search query, the candidates considered
-- (with scores and kcal per 100 g) and which one was chosen. JSON, nullable.
ALTER TABLE consumed_item ADD COLUMN match_json TEXT;

-- Corrections the user made: "when I say <term>, I mean <food>". Checked before any search.
CREATE TABLE food_alias (
  user_id     TEXT NOT NULL REFERENCES users(id),
  term_norm   TEXT NOT NULL,
  food_id     TEXT NOT NULL REFERENCES food(id),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, term_norm)
);
