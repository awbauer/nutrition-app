# Meal Tracker PWA

A personal iPhone PWA that logs meals from photos, voice or text and stores them as structured, FHIR-aligned nutrition data. Runs entirely on Cloudflare. AI identifies foods and portions; **nutrient values always come from food databases** (USDA FoodData Central, Open Food Facts), never from the model.

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

## Deploy

1. `npx wrangler login`
2. `npm run deploy` — wrangler provisions the D1 database and R2 bucket on first deploy.
3. `npm run db:migrate:remote`
4. Secrets:
   - `npx wrangler secret put USDA_API_KEY` (free key from <https://fdc.nal.usda.gov/api-key-signup>)
   - Web Push: run `node scripts/vapid-keys.mjs`, then `wrangler secret put` each of `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (a `mailto:` address)
5. Create an AI Gateway named `nutrition` (or set `AI_GATEWAY_ID`), with log retention set — logs include meal photos.
6. Create a Cloudflare Access self-hosted application for the Worker's hostname, then set `ACCESS_TEAM_DOMAIN` (e.g. `myteam.cloudflareaccess.com`) and `ACCESS_AUD` (the application's AUD tag) in `wrangler.jsonc` vars or the dashboard. **Without both, every API call returns 401** (unless `DEV_AUTH=1`, which must never be set in production).
7. Open the site on iPhone in Safari → Share → Add to Home Screen, open it from the Home Screen, then Settings → Reminders → Turn on notifications.

The Cron Trigger runs every 15 minutes and sends reminders that are due in each user's time zone.

## Data model

Tables mirror FHIR resources so a FHIR export is a mapping, not a redesign. See [docs/fhir-mapping.md](docs/fhir-mapping.md).
