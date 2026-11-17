-- Recipes: a batch cooked once and eaten in portions over several days. Additive.
-- The recipe itself is a `food` row (source 'recipe', owned by the user) whose per-100 g nutrients
-- are computed from the ingredients, so logging a portion works like logging any other food.
-- Past logs keep the nutrients they were logged with; editing a recipe only affects new logs.
CREATE TABLE recipe (
  food_id      TEXT PRIMARY KEY REFERENCES food(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  servings     REAL NOT NULL,              -- portions the batch makes
  yield_grams  REAL,                       -- weight of the finished batch, if weighed (cooking changes weight)
  archived     INTEGER NOT NULL DEFAULT 0, -- deleted by the user; kept because past logs point at the food
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX recipe_user ON recipe (user_id, archived);

CREATE TABLE recipe_ingredient (
  id              TEXT PRIMARY KEY,
  recipe_food_id  TEXT NOT NULL REFERENCES recipe(food_id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  food_id         TEXT NOT NULL REFERENCES food(id),
  display_name    TEXT NOT NULL,
  amount_value    REAL NOT NULL,
  amount_unit     TEXT NOT NULL,
  grams           REAL NOT NULL
);
CREATE INDEX recipe_ingredient_recipe ON recipe_ingredient (recipe_food_id, position);
