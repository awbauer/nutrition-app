# Clem

Clem is a personal iPhone PWA that logs meals from photos, voice or text and stores them as structured, FHIR-aligned nutrition data. Runs entirely on Cloudflare. AI identifies foods and portions; **nutrient values always come from food databases** (USDA FoodData Central, Open Food Facts), never from the model.

The build spec lives in [docs/spec.md](docs/spec.md); work is tracked in GitHub issues by phase.

## Stack

| Layer | Choice |
| --- | --- |
| Frontend | Vite + Preact + Tailwind v4, served as Worker static assets |
| API | Cloudflare Worker (Hono) |
| Auth | Cloudflare Access; JWT validated in the Worker |
| Data | D1 (numbered migrations in `migrations/`) |
| Media | R2 (private) |
| AI | Workers AI through AI Gateway |
| Schedules | Cron Trigger every 15 min (reminders) |

> The spec names Pages for the frontend. This repo serves the PWA from the same Worker using static assets instead: one deploy, one origin, one Access application, and it is Cloudflare's recommended path for new projects.

## Layout

```
src/worker/        Worker: app.ts (routes), auth.ts, lib/ (domain logic), routes/
web/               PWA: index.html, src/ (Preact), public/ (manifest, icons, service worker)
migrations/        D1 schema, applied in order
test/              Vitest running inside workerd (@cloudflare/vitest-plugin)
docs/              Spec and FHIR mapping
```

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars      # DEV_AUTH=1 bypasses Access locally
npm run db:migrate:local
npm run build && npx wrangler dev   # http://localhost:8787 (or --port 8788)
```

`npm run dev:web` runs Vite with HMR and proxies `/api` to `wrangler dev`.

```bash
npm test          # worker + domain tests in workerd
npm run typecheck
```

## Matching evaluation

Every weight, threshold and word list the food matcher uses is in `src/worker/lib/match-config.ts`. The matcher version recorded with each AI-logged item (and grouped on the logging-quality card) is a hash of that config, so it changes by itself when a weight does; bump `logic` there when scoring code changes in a way the numbers don't show.

Ranking is a pure function, `decide()` in `src/worker/lib/decide.ts`. `test/golden.test.ts` runs it over the real cases in `test/fixtures/golden-matches.json` (each with the candidates the food databases returned, so it runs offline) and fails if fewer than its baseline are right. After a tuning change, run `npx vitest run test/golden.test.ts`: it prints the hit rate and every miss.

To add cases from what you've logged locally:

```bash
# Items the AI logged in the local D1: swapped ones become reviewed cases (the food you swapped to is the answer),
# the rest unreviewed. --refetch re-runs the USDA and FatSecret searches for full candidate lists (keys from .dev.vars).
npm run golden -- --db .wrangler/state/v3/d1/miniflare-D1DatabaseObject/<id>.sqlite --refetch
# or from an export: npx wrangler d1 export nutrition --local --output local.sql
npm run golden -- --db local.sql --refetch
# Hand-written cases (name, estimate, expected foods): add to test/fixtures/golden-queries.json, then
npm run golden -- --queries test/fixtures/golden-queries.json --refetch
```

Existing cases are kept (pass `--replace` to rebuild them). Review each new `"status": "unreviewed"` case: set `expect` to the acceptable food names and `status` to `"reviewed"`; only reviewed cases count toward the hit rate. The fixture holds food names, brands, public database ids and nutrients only: no user or item ids, dates, meal text or custom foods.

## Deploy

1. `npx wrangler login`
2. `npm run deploy` — wrangler provisions the D1 database and R2 bucket on first deploy.
3. `npm run db:migrate:remote`
4. Secrets:
   - `npx wrangler secret put USDA_API_KEY` (free key from <https://fdc.nal.usda.gov/api-key-signup>)
   - Web Push: run `node scripts/vapid-keys.mjs`, then `wrangler secret put` each of `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (a `mailto:` address)
5. Create an AI Gateway named `nutrition` (or set `AI_GATEWAY_ID`), with log retention set — logs include meal photos.
6. Create a Cloudflare Access self-hosted application for the Worker's hostname, then store `ACCESS_TEAM_DOMAIN` (e.g. `myteam.cloudflareaccess.com`) and `ACCESS_AUD` (the application's AUD tag) with `wrangler secret put`. They are secrets rather than vars so they stay out of the repo. **Without both, every API call returns 401** (unless `DEV_AUTH=1`, which must never be set in production).
7. Open the site on iPhone in Safari → Share → Add to Home Screen, open it from the Home Screen, then Settings → Reminders → Turn on notifications.

The Cron Trigger runs every 15 minutes and sends reminders that are due in each user's time zone.

## How updates reach the installed app

`npm run deploy` builds, applies pending D1 migrations, then deploys the Worker. Each build is stamped with a version (git SHA + build time) that is written to `/version.json` and into `sw.js`.

- A changed `sw.js` makes the browser install a new service worker, which precaches the new shell and deletes old caches.
- The app checks `/version.json` when it returns to the foreground and every 15 minutes. If the version changed, it reloads at once, unless a sheet is open, a save is in flight or text is being typed. Then it shows an "A new version is ready" banner and reloads at the next quiet moment.
- Meals waiting in the offline queue live in IndexedDB and survive the reload.
- Migrations run before the new Worker goes live, and old clients may still call the API for a few minutes, so keep schema changes additive (add columns/tables; drop only in a later release).

The running version is shown at the bottom of Settings.

## Data model

Tables mirror FHIR resources so a FHIR export is a mapping, not a redesign. See [docs/fhir-mapping.md](docs/fhir-mapping.md).
