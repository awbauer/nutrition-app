-- The source database's own category for a food (USDA foodCategory / WWEIA / branded category,
-- Open Food Facts categories), used to offer sensible amount sizes. Additive; null for older rows
-- until they're next fetched, and for custom foods.
ALTER TABLE food ADD COLUMN category TEXT;
