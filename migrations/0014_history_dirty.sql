-- Incremental refresh of "foods you've eaten" (lib/history.ts). Triggers mark each (user, food) whose
-- history_entry may have changed, in the same statement as the change, so no write path can forget to;
-- the refresh recomputes only those foods and deletes the marks it read (newer marks have higher ids).
CREATE TABLE history_dirty (
  id       INTEGER PRIMARY KEY,
  user_id  TEXT NOT NULL,
  food_id  TEXT NOT NULL
);
CREATE INDEX history_dirty_user ON history_dirty (user_id, id);

-- Per-user refresh state: when history was last rebuilt in full (NULL: never, so the next refresh
-- backfills), and which refresh is running (claim), so two don't race on one user.
CREATE TABLE history_state (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  rebuilt_at  TEXT,
  claim       TEXT,
  claimed_at  TEXT
);

-- What a history entry is made of: the item's user, food, wording and meal ...
CREATE TRIGGER history_dirty_item_insert AFTER INSERT ON consumed_item
WHEN NEW.food_id IS NOT NULL
BEGIN
  INSERT INTO history_dirty (user_id, food_id) VALUES (NEW.user_id, NEW.food_id);
END;

CREATE TRIGGER history_dirty_item_update AFTER UPDATE OF user_id, food_id, display_name, intake_id ON consumed_item
WHEN OLD.user_id IS NOT NEW.user_id OR OLD.food_id IS NOT NEW.food_id OR OLD.display_name IS NOT NEW.display_name OR OLD.intake_id IS NOT NEW.intake_id
BEGIN
  INSERT INTO history_dirty (user_id, food_id) SELECT OLD.user_id, OLD.food_id WHERE OLD.food_id IS NOT NULL;
  INSERT INTO history_dirty (user_id, food_id) SELECT NEW.user_id, NEW.food_id
    WHERE NEW.food_id IS NOT NULL AND (OLD.user_id IS NOT NEW.user_id OR OLD.food_id IS NOT NEW.food_id);
END;

CREATE TRIGGER history_dirty_item_delete AFTER DELETE ON consumed_item
WHEN OLD.food_id IS NOT NULL
BEGIN
  INSERT INTO history_dirty (user_id, food_id) VALUES (OLD.user_id, OLD.food_id);
END;

-- ... the meal's status (only completed meals count) and time ...
CREATE TRIGGER history_dirty_intake_update AFTER UPDATE OF status, occurrence_at ON nutrition_intake
WHEN OLD.status IS NOT NEW.status OR OLD.occurrence_at IS NOT NEW.occurrence_at
BEGIN
  INSERT INTO history_dirty (user_id, food_id) SELECT user_id, food_id FROM consumed_item WHERE intake_id = NEW.id AND food_id IS NOT NULL;
END;

-- ... the food's name, brand, source and archiving, for everyone who ate it ...
CREATE TRIGGER history_dirty_food_update AFTER UPDATE OF name, brand, source, archived_at ON food
WHEN OLD.name IS NOT NEW.name OR OLD.brand IS NOT NEW.brand OR OLD.source IS NOT NEW.source OR OLD.archived_at IS NOT NEW.archived_at
BEGIN
  INSERT INTO history_dirty (user_id, food_id) SELECT DISTINCT user_id, NEW.id FROM consumed_item WHERE food_id = NEW.id;
END;

-- ... and whether it is an archived recipe.
CREATE TRIGGER history_dirty_recipe_insert AFTER INSERT ON recipe
WHEN NEW.archived = 1
BEGIN
  INSERT INTO history_dirty (user_id, food_id) SELECT DISTINCT user_id, NEW.food_id FROM consumed_item WHERE food_id = NEW.food_id;
END;

CREATE TRIGGER history_dirty_recipe_update AFTER UPDATE OF archived ON recipe
WHEN OLD.archived IS NOT NEW.archived
BEGIN
  INSERT INTO history_dirty (user_id, food_id) SELECT DISTINCT user_id, NEW.food_id FROM consumed_item WHERE food_id = NEW.food_id;
END;

CREATE TRIGGER history_dirty_recipe_delete AFTER DELETE ON recipe
WHEN OLD.archived = 1
BEGIN
  INSERT INTO history_dirty (user_id, food_id) SELECT DISTINCT user_id, OLD.food_id FROM consumed_item WHERE food_id = OLD.food_id;
END;
