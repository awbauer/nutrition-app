# Meal Tracker PWA: Build Spec

## 1. Overview

A personal progressive web app (PWA) for iPhone that logs meals from photos, voice, or text and turns them into structured nutrition data. It runs entirely on Cloudflare. AI models identify foods and portions; nutrition values come from authoritative food databases, not from the model. The data model mirrors HL7 FHIR so a FHIR export later is a mapping exercise, not a redesign.

Single user at launch. Every table is keyed by user from day one so more people can be added later.

### Goals

- Log a meal in under 15 seconds for common cases.
- Store every meal as structured data: time, meal type, items, amounts, calories, macros, and key micronutrients.
- Ask at most two quick clarifying questions per meal, answered by tapping, not typing.
- Track daily calorie and protein targets and body weight trend.
- Send reminders to log meals at set times.
- Export to CSV and JSON; FHIR export later.

### Non-goals for v1

- Social features, coaching content, or meal plans.
- Native iOS app. PWA only.
- In-app reporting dashboards beyond simple daily and weekly views (planned for v2).

## 2. Architecture

### Components

| Layer | Cloudflare service | Purpose |
| --- | --- | --- |
| Frontend | Pages | PWA shell, service worker, manifest, offline queue |
| API | Workers | REST API, orchestration of model calls and food lookups |
| Auth | Access | Login; identity comes from the Access JWT (email and sub) |
| Database | D1 | All structured data |
| Object storage | R2 | Meal photos and voice clips |
| AI | Workers AI via AI Gateway | Vision, text parsing, speech to text |
| Scheduling | Cron Triggers | Reminder dispatch, daily rollups |
| Cache | KV (optional) | Food lookup cache, model config |

### Request flow: logging a meal

1. User submits a photo, a voice clip, or text from the PWA.
2. Worker stores raw media in R2 and creates a draft intake with status `preparation`.
3. If voice: Whisper transcribes to text.
4. Vision model (photo) or text model (text) returns a list of candidate foods with estimated portions and a confidence score per item.
5. Worker resolves each food against the food cache, then USDA FoodData Central, then Open Food Facts.
6. If any item is below the confidence threshold or ambiguous in a way that changes calories by more than about 15%, the Worker returns up to two clarifying questions with tap options.
7. User answers or accepts defaults. Worker computes nutrient totals from database values times amounts.
8. Intake status becomes `completed`. Daily totals update.

### Model roles

All calls route through one AI Gateway so logging, caching, rate limits, and model swaps are central. Model IDs live in a settings table, not in code.

| Role | Default (Workers AI) | Job |
| --- | --- | --- |
| Vision | Llama 4 Scout or Llama 3.2 Vision | Identify foods and estimate portions from a photo |
| Parser | Llama 3.3 70B or similar | Turn text into structured items; write clarifying questions |
| Speech | Whisper (large v3 turbo) | Voice to text |

Models must return JSON matching a fixed schema. The Worker validates every response and retries once on bad output.

Later option: route Vision or Parser to OpenAI or Anthropic through the same gateway, chosen in settings.

### Food data sources

- USDA FoodData Central API. Free with an API key. Primary source for whole foods and generic dishes. Store the FDC ID with every item.
- Open Food Facts API. Free. Packaged and branded foods, keyed by GTIN barcode.
- Local food cache in D1. Every resolved food is saved so repeat meals skip external calls.
- User custom foods and recipes. Created by the user, same structure as database foods.

## 3. Data Model (FHIR-aligned)

Tables use our own lightweight shape, but names and structure follow FHIR so each maps one to one.

### FHIR mapping summary

| Our table | FHIR resource | Notes |
| --- | --- | --- |
| users | Patient | Subject of all records |
| nutrition\_intake | NutritionIntake | One row per meal or snack |
| consumed\_item | NutritionIntake.consumedItem | One row per food in a meal |
| intake\_nutrient | NutritionIntake.consumedItem.totalIntake | Nutrient totals per item |
| food | NutritionProduct | Cached and custom foods |
| food\_nutrient | NutritionProduct.nutrient | Per 100 g values |
| goal | Goal | Calorie, protein, weight targets |
| observation | Observation | Body weight (LOINC 29463-7) |

### users

- id (text, primary key)
- access\_sub (text, unique) from the Access JWT
- email
- timezone (IANA)
- created\_at

### nutrition\_intake

- id
- user\_id
- status: `preparation`, `in-progress`, `completed`, `entered-in-error` (FHIR event status)
- meal\_type: `breakfast`, `lunch`, `dinner`, `snack` (maps to NutritionIntake.code)
- occurrence\_at (datetime, when eaten)
- recorded\_at (datetime, when logged)
- source: `photo`, `voice`, `text`, `manual`, `copy`
- media\_r2\_key (nullable)
- raw\_input\_text (nullable; transcript or typed text)
- note
- confidence (0 to 1, lowest item confidence)

### consumed\_item

- id
- intake\_id
- food\_id
- display\_name
- amount\_value
- amount\_unit (UCUM: `g`, `mL`, or a serving unit mapped to grams)
- grams (normalized weight used for math)
- confidence (0 to 1)
- estimation\_method: `photo-estimate`, `described`, `weighed`, `label`

### intake\_nutrient

- consumed\_item\_id
- nutrient\_code (INFOODS tagname, for example `ENERC_KCAL`, `PROCNT`, `FAT`, `CHOCDF`, `FIBTG`, `SUGAR`, `NA`)
- usda\_nutrient\_id (for example 1008 for energy)
- value
- unit (UCUM)

### food

- id
- source: `usda`, `off`, `custom`, `recipe`
- source\_id (FDC ID or GTIN)
- name, brand
- default\_serving\_grams
- owner\_user\_id (null for shared database foods)

### food\_nutrient

- food\_id, nutrient\_code, usda\_nutrient\_id, value\_per\_100g, unit

### goal

- id, user\_id
- type: `energy`, `protein`, `body-weight`
- target\_value, unit
- start\_date, end\_date (nullable)
- status: `active`, `completed`, `cancelled`

### observation

- id, user\_id
- code: LOINC `29463-7` (body weight)
- value, unit (`kg` stored; display in lb if preferred)
- effective\_at

## 4. Logging and Clarifying Questions

The model proposes; the database supplies numbers; the user confirms with taps.

### Model output schema (vision and parser)

```json
{
  "meal_type_guess": "lunch",
  "items": [
    {"name": "grilled chicken breast", "amount": 150, "unit": "g", "confidence": 0.7,
     "search_terms": ["chicken breast grilled"], "barcode": null}
  ],
  "questions": [
    {"id": "q1", "item_index": 0, "text": "Cooked in oil or butter?",
     "options": ["None", "1 tsp oil", "1 tbsp oil", "Butter"], "default": "1 tsp oil"}
  ]
}
```

### Question rules

- At most two questions per meal. Fewer is better.
- Ask only when the answer moves calories by about 15% or more, or the food can't be matched.
- Every question has 2 to 4 tap options and a preselected default.
- Common targets: cooking fat, portion size (small, medium, large with grams shown), dressing or sauce, drink size.
- Skipping a question accepts the default and lowers item confidence.

### Smart assumptions

- Learn defaults from history: if the user always takes coffee with 2% milk, assume it.
- Saved favorites and recipes match before any database search.
- Time defaults to now; meal type defaults from time of day and the user's usual pattern.
- "Same as yesterday's breakfast" and "copy meal" are first-class actions.

### Food matching

1. Exact match in user custom foods or recipes.
2. Fuzzy match in the local food cache.
3. USDA FoodData Central search (Foundation and SR Legacy first, then Survey FNDDS for mixed dishes, then Branded).
4. Open Food Facts by barcode or brand name.
5. No match: the parser estimates nutrients, the item is flagged `estimated`, confidence capped at 0.4.

### Edits

Every item stays editable after logging: swap the food, change grams, delete. Edits recompute totals. Deleting a meal sets status `entered-in-error`, never a hard delete.

## 5. Targets, Weight, and Progress

Daily calories and protein are the core targets; weight trend drives adjustments.

### Targets

- Daily energy target (kcal) and protein target (g), stored as Goal rows.
- Optional fat, carb, and fiber targets.
- Starting energy target from a standard formula (Mifflin-St Jeor plus activity factor) using height, weight, age, sex, and goal rate entered at setup.

### Weight trend

- Log weigh-ins as Observations. Show a smoothed trend (7-day exponential moving average), not raw daily values.
- Daily swings are mostly water; the trend is what matters.

### Adaptive target (v1.5)

- After 3 or more weeks of data, estimate real daily energy expenditure from average intake versus trend weight change (about 7,700 kcal per kg).
- Suggest a revised target; the user approves it. Never change it silently.

### Views

- Today: calories and protein remaining, meals logged, quick add.
- Week: daily totals, weekly average against target, logging streak.
- Weekly average is the headline number; one big day should not read as failure.

### Data quality

- Show each meal's confidence. Photo estimates can be off by 20% or more; weighed or label entries are better.
- Consistent logging beats perfect precision. Missed days hurt the data more than rough estimates.

## 6. Reminders and Notifications

Web Push from a scheduled Worker reminds the user to log at set times.

- iOS supports Web Push only for PWAs added to the Home Screen (iOS 16.4 or later). Onboarding must walk through Add to Home Screen before asking for notification permission.
- Store push subscriptions in a `push_subscription` table (user\_id, endpoint, keys, created\_at).
- `reminder` table: user\_id, label, local\_time, days\_of\_week, enabled.
- A Cron Trigger runs every 15 minutes, converts each reminder to the user's time zone, and sends pushes that are due.
- Skip a reminder if a meal of that type was already logged in the window.
- Optional end-of-day nudge: "You have 600 kcal and 40 g protein left."
- Use VAPID keys stored as Worker secrets.

## 7. API (Worker)

All routes require a valid Access JWT; the Worker maps it to `user_id`.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | /api/intake | Create draft from photo, audio, or text (multipart) |
| POST | /api/intake/:id/answers | Submit answers to clarifying questions |
| PATCH | /api/intake/:id | Edit time, meal type, note, status |
| PATCH | /api/item/:id | Edit an item's food or amount |
| GET | /api/day/:date | Day totals, meals, targets remaining |
| GET | /api/range?from=&to= | Daily totals for a range |
| POST | /api/intake/:id/copy | Copy a meal to now |
| GET, POST | /api/foods | Search foods; create custom food or recipe |
| GET, PUT | /api/goals | Read and set targets |
| POST | /api/weight | Log a weigh-in |
| GET, PUT | /api/settings | Model choices, units, thresholds |
| POST | /api/push/subscribe | Save push subscription |
| GET, PUT | /api/reminders | Manage reminders |
| GET | /api/export?format=csv or json&from=&to= | Export data |

## 8. Settings

- Model per role (vision, parser, speech), picked from a list of Workers AI models; later, external providers through AI Gateway.
- Confidence threshold for questions (default 0.6) and max questions (default 2).
- Units: kg or lb, g or oz.
- Time zone.
- Targets and reminder times.

## 9. Export and Reporting

- CSV, one row per consumed item: date, time, meal type, food, FDC ID, grams, kcal, protein, fat, carbs, fiber, confidence, source.
- CSV, one row per day: totals versus targets, weight trend.
- JSON: full structured records using the FHIR-aligned field names.
- FHIR export (v2): a Bundle of NutritionIntake, Goal, and Observation resources.
- In-app reporting (v2): trends for calories, protein, and weight; adherence by meal type and weekday.

## 10. PWA and iPhone Details

- Manifest with `display: standalone`, icons, theme color; Add to Home Screen onboarding.
- Camera through `<input type="file" accept="image/*" capture="environment">`; resize to about 1024 px client side before upload.
- Voice through MediaRecorder, sent to Whisper on the Worker. Do not depend on the browser speech API in standalone mode.
- Service worker caches the shell; an IndexedDB queue holds meals logged offline and syncs on reconnect.
- Plain frontend stack: Vite with Preact or React, Tailwind. Keep the bundle small.

## 11. Security and Privacy

- Cloudflare Access in front of Pages and the Worker; validate the JWT in the Worker too.
- Every query filtered by `user_id`.
- R2 bucket private; photos served through signed or authenticated Worker routes.
- API keys (USDA, VAPID) in Worker secrets.
- AI Gateway logging on for debugging; set a retention period, since logs include meal photos.
- Account export and delete for future users.

## 12. Quality, Versioning, and Operations

These keep the data trustworthy as models and code change.

### Accuracy test set

- Build a set of about 30 meals with weighed portions and known nutrient totals, each with a photo and a text description.
- Run every candidate vision and parser model against it. Score item identification, gram error, and kcal and protein error.
- Rerun before any model or prompt change ships.

### Serving to gram conversion

- Convert household measures (cup, slice, tbsp, piece) to grams using USDA FoodData Central `foodPortions` for the matched food.
- Fall back to `default_serving_grams` on the food, then a generic unit table.
- Store both the original amount and unit and the normalized grams on `consumed_item`.

### Day boundary

- A configurable day cutoff, default 04:00 local time. Meals before the cutoff count toward the previous day.
- Store `occurrence_at` in UTC plus the user's time zone at log time; compute `log_date` from both.

### Model and prompt versioning

- Add `model_id`, `prompt_version`, and `pipeline_version` to `nutrition_intake`.
- Prompts live in a versioned `prompt` table or in code with a version constant.
- Lets reports separate a real change in eating from a change in the estimator.

### Cost and backups

- Set rate limits and a monthly spend alert in AI Gateway; enable gateway caching for repeat text prompts.
- Enable D1 Time Travel for point-in-time restore; run schema changes as numbered migrations.
- Weekly export of D1 to R2 as an extra backup.

## 13. Build Phases

1. **Foundation:** Pages, Worker, D1 schema, Access, R2. Manual text entry with USDA lookup and daily totals.
2. **AI logging:** AI Gateway, parser model, vision model, clarifying questions, food cache.
3. **Voice:** recording and Whisper.
4. **Targets and weight:** goals, weigh-ins, trend line, Today and Week views.
5. **Reminders:** Web Push, cron dispatch, Home Screen onboarding.
6. **Export:** CSV and JSON.
7. **v1.5:** adaptive target, favorites and recipes, barcode scanning with Open Food Facts.
8. **v2:** FHIR export, reporting screens, multiple users, external models.

## 14. Open Questions

- Track micronutrients beyond sodium and fiber in v1?
- Keep photos forever, or delete after a set period?
- Which external models, if any, for the vision role once Workers AI is benchmarked?
- Target macro split, or protein only plus calories?
