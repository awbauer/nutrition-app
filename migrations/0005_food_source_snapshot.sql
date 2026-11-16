-- The source database's record for a food (USDA FoodData Central JSON as received, less per-sample
-- lab details and row bookkeeping; see snapshotOf), so fields the app doesn't use yet can be read later without fetching again. Kept apart from
-- `food` so searches over food rows stay small. A full detail record is never replaced by the
-- thinner search-result version. Additive.
CREATE TABLE food_source_snapshot (
  food_id     TEXT PRIMARY KEY REFERENCES food(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('search', 'detail')),
  payload     TEXT NOT NULL,
  fetched_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
