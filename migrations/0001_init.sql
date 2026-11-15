-- Core schema. Names follow HL7 FHIR resources (see docs/fhir-mapping.md).
-- Every user-owned table carries user_id; every query filters on it.

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  access_sub  TEXT NOT NULL UNIQUE,
  email       TEXT,
  timezone    TEXT NOT NULL DEFAULT 'UTC',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Per-user settings as JSON values (model ids, thresholds, units, day cutoff).
CREATE TABLE settings (
  user_id     TEXT NOT NULL REFERENCES users(id),
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, key)
);

-- FHIR NutritionProduct. owner_user_id NULL = shared database food.
CREATE TABLE food (
  id                     TEXT PRIMARY KEY,
  source                 TEXT NOT NULL CHECK (source IN ('usda', 'off', 'custom', 'recipe', 'estimate')),
  source_id              TEXT,
  name                   TEXT NOT NULL,
  name_norm              TEXT NOT NULL,
  brand                  TEXT,
  data_type              TEXT,
  default_serving_grams  REAL,
  portions_json          TEXT NOT NULL DEFAULT '[]',
  owner_user_id          TEXT REFERENCES users(id),
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX food_source_shared ON food (source, source_id) WHERE owner_user_id IS NULL AND source_id IS NOT NULL;
CREATE INDEX food_owner ON food (owner_user_id);
CREATE INDEX food_name_norm ON food (name_norm);

-- FHIR NutritionProduct.nutrient, per 100 g.
CREATE TABLE food_nutrient (
  food_id           TEXT NOT NULL REFERENCES food(id) ON DELETE CASCADE,
  nutrient_code     TEXT NOT NULL,
  usda_nutrient_id  INTEGER,
  value_per_100g    REAL NOT NULL,
  unit              TEXT NOT NULL,
  PRIMARY KEY (food_id, nutrient_code)
);

-- FHIR NutritionIntake: one row per meal or snack.
CREATE TABLE nutrition_intake (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  status            TEXT NOT NULL CHECK (status IN ('preparation', 'in-progress', 'completed', 'entered-in-error')),
  meal_type         TEXT NOT NULL CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
  occurrence_at     TEXT NOT NULL,           -- UTC ISO-8601
  occurrence_tz     TEXT NOT NULL,           -- IANA zone at log time
  log_date          TEXT NOT NULL,           -- YYYY-MM-DD after day cutoff
  recorded_at       TEXT NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('photo', 'voice', 'text', 'manual', 'copy')),
  media_r2_key      TEXT,
  raw_input_text    TEXT,
  note              TEXT,
  confidence        REAL,
  model_id          TEXT,
  prompt_version    TEXT,
  pipeline_version  TEXT,
  pending_json      TEXT,                    -- draft state: parsed items + open questions
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX intake_user_date ON nutrition_intake (user_id, log_date);
CREATE INDEX intake_user_meal ON nutrition_intake (user_id, meal_type, occurrence_at);

-- FHIR NutritionIntake.consumedItem
CREATE TABLE consumed_item (
  id                 TEXT PRIMARY KEY,
  intake_id          TEXT NOT NULL REFERENCES nutrition_intake(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL REFERENCES users(id),
  position           INTEGER NOT NULL DEFAULT 0,
  food_id            TEXT REFERENCES food(id),
  display_name       TEXT NOT NULL,
  amount_value       REAL NOT NULL,
  amount_unit        TEXT NOT NULL,
  grams              REAL NOT NULL,
  confidence         REAL NOT NULL DEFAULT 1,
  estimation_method  TEXT NOT NULL CHECK (estimation_method IN ('photo-estimate', 'described', 'weighed', 'label')),
  estimated          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX item_intake ON consumed_item (intake_id);
CREATE INDEX item_user ON consumed_item (user_id);

-- FHIR NutritionIntake.consumedItem.totalIntake
CREATE TABLE intake_nutrient (
  consumed_item_id  TEXT NOT NULL REFERENCES consumed_item(id) ON DELETE CASCADE,
  nutrient_code     TEXT NOT NULL,
  usda_nutrient_id  INTEGER,
  value             REAL NOT NULL,
  unit              TEXT NOT NULL,
  PRIMARY KEY (consumed_item_id, nutrient_code)
);

-- FHIR Goal
CREATE TABLE goal (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  type          TEXT NOT NULL CHECK (type IN ('energy', 'protein', 'fat', 'carbs', 'fiber', 'body-weight')),
  target_value  REAL NOT NULL,
  unit          TEXT NOT NULL,
  start_date    TEXT NOT NULL,
  end_date      TEXT,
  status        TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX goal_user ON goal (user_id, status);

-- FHIR Observation (body weight, LOINC 29463-7), stored in kg.
CREATE TABLE observation (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  code          TEXT NOT NULL DEFAULT '29463-7',
  value         REAL NOT NULL,
  unit          TEXT NOT NULL DEFAULT 'kg',
  effective_at  TEXT NOT NULL,
  log_date      TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX obs_user_date ON observation (user_id, code, log_date);

CREATE TABLE push_subscription (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE reminder (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  label         TEXT NOT NULL,
  meal_type     TEXT CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
  kind          TEXT NOT NULL DEFAULT 'meal' CHECK (kind IN ('meal', 'end-of-day')),
  local_time    TEXT NOT NULL,              -- HH:MM in the user's zone
  days_of_week  TEXT NOT NULL DEFAULT '0123456', -- 0 = Sunday
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_sent_on  TEXT                         -- local date last sent, prevents duplicates
);
CREATE INDEX reminder_user ON reminder (user_id);
