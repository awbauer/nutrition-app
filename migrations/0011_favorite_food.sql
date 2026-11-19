-- Starred foods: a food with the name and amount to log it by, shown first in Quick add.
-- One per name per user (starring "oreos" again updates its food and amount).
CREATE TABLE favorite_food (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  name_norm   TEXT NOT NULL,
  food_id     TEXT NOT NULL REFERENCES food(id),
  amount      REAL NOT NULL,
  unit        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, name_norm)
);
CREATE INDEX favorite_food_user ON favorite_food (user_id, created_at);
