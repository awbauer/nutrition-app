-- Indexes for lookups that scanned whole tables:
-- how often a custom food or recipe was logged (consumed_item by food_id, lib/foods.ts and lib/recipes.ts),
-- and which users logged anything recently (nutrition_intake by user and recorded_at, the coach's daily run).
CREATE INDEX IF NOT EXISTS item_food ON consumed_item (food_id);
CREATE INDEX IF NOT EXISTS intake_user_recorded ON nutrition_intake (user_id, recorded_at);
