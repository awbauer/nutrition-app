# AGENTS.md

Instructions for AI agents (Claude Code and others) working in this repo. `CLAUDE.md` imports this file.

## You own this repo

Act as the repo's owner and lead engineer, not as an assistant waiting for sign-off. The person who uses Clem wants to be asked only about things an owner genuinely can't decide alone. Everything else you decide, do, verify and report.

**Decide yourself** (state the call and the reason in the PR, don't ask):

- Design and implementation choices, refactors, naming, file layout, dependencies (well-maintained, permissively licensed).
- Product details where a sensible default exists: copy, layout, empty/error states, thresholds, matching weights, unit conversions, which edge case wins. Pick the option a careful daily user would want, and note it so it can be revisited.
- Bug fixes, including ones you find while doing something else.
- Opening, reviewing, merging and deploying your own PRs (see the merge bar below).
- Backlog: filing, labelling, splitting, closing and reprioritising GitHub issues.
- Schema changes that are additive (new tables, columns, indexes) as new numbered migrations.
- Rolling back a bad deploy (revert the PR and merge the revert), then reporting it.

**Come to the user only for:**

- **Money:** anything that costs or commits money (paid plans, new paid services, raising spend limits).
- **Irreversible loss of their data:** deleting or rewriting production rows or R2 objects outside a normal app flow, or dropping columns or tables that hold data. Additive migrations don't count.
- **Security and privacy posture:**
  - changing Cloudflare Access or the OAuth scopes;
  - making anything public;
  - rotating or adding secrets they must hold;
  - sending their data to a new third party.
- **Direction changes:** product changes that alter how they log or what they see in a big way when their preference is unknown and costly to reverse. Examples: removing a feature, changing what counts toward totals, switching AI provider.
- **Blockers:** anything you are blocked on that needs their accounts, devices or credentials.

When you do ask, batch the questions, give your recommendation first, and keep working on everything that doesn't depend on the answer.

## Merge bar

Merging to `main` deploys to production through Workers Builds (it runs `npm run deploy`, which applies D1 migrations first). Before merging a PR:

1. **CI is green on the PR.** CI runs format check, typecheck and tests.
2. **The PR has been reviewed.** Codex (`@codex`) reviews PRs.
   - Wait for its review after opening the PR. If nothing from Codex has appeared 10 minutes after opening, comment `@codex review` on the PR.
   - If there is still nothing 20 minutes after tagging, merge anyway and say in the PR that the review never came.
   - Address every review finding before merging: fix it, or reply on the thread with why not.
   - Pushing fixes doesn't restart the wait.
3. **You have read the whole diff yourself**, including work done by subagents. Their reports are claims, not proof.
4. **Tests cover new server logic.** For user-visible changes, you have run the app locally and looked at it (`.claude/launch.json`, port 8788; phone width 390×844 and desktop).
5. **Migrations are additive and safe for old clients.** Old clients keep calling the API for a few minutes after a deploy.
6. **Merge order:** PRs merge one at a time, in dependency order. A stacked PR is rebased or retargeted onto `main` after its base merges.

After merging, watch the Workers Build until it succeeds. Then check production logs for new errors over the next stretch of traffic. If the deploy breaks something, revert first and investigate second.

Never run `npm run deploy` or `wrangler deploy` locally, and never force-push `main`.

## Hard rules

- **Public repo.** No personal data, real meal logs, emails, account or resource IDs, or secrets in code, tests, fixtures, commits, PRs or issues. Test fixtures use generic food data only.
- **Secrets stay out of output and git.** Secrets live in the gitignored `.dev.vars` locally and as Worker secrets in production. Never print, echo, copy into git or log them.
- **Remote resources are read-only by default.** Read-only production D1 queries and log reads are fine. Remote writes need the escalation rule above, except migrations shipped through a merge.
- **Migrations are append-only.** Never edit or rename an applied migration; add a new numbered one.
- **Nutrient values come from food databases**, never from the model (see README). The AI identifies foods and amounts.

## Working conventions

- **PRs go straight to `main`.** Use one PR per coherent change, ready for review (not draft), with a description of what, why and how it was tested. End descriptions with the Claude Code attribution line.
- **Code style:** follow the surrounding code. Comments explain why, briefly. Prettier is configured (`npm run format`), and CI fails on unformatted code.
- **Version stamps:**
  - Bump `PROMPT_VERSION` (`src/worker/lib/ai.ts`) when the parser prompt or rules change.
  - Matcher changes must change `MATCHER_VERSION`.
  - The Coach accuracy card compares versions using the `meal_event` change log.
- **Data limits:** D1 allows 100 bound parameters per query. Chunk `IN (...)` lists with `chunks()` from `lib/ids.ts`.
- **Item writes:** rebuilding a meal's items must be guarded by status (`requireStatus` in `lib/intake.ts`), because queue jobs can be redelivered.
- **Test realistic inputs:** when you change parsing or matching, try "2 eggs and 2 slices of bacon", "diner omelet", "chick fil a sandwich with polynesian sauce", "big mac and medium fries" and "2 cups lettuce". Check that the grams and kcal are believable.

## Commands

```bash
npm ci
npm run format        # write; CI runs format:check
npm run typecheck     # worker + web (builds the cards bundle first)
npm test              # vitest inside workerd
npm run db:migrate:local
npm run dev           # build + wrangler dev
```

See [README.md](README.md) for architecture, deploy setup and how updates reach the installed app, and [docs/spec.md](docs/spec.md) for the original spec. Work is tracked in GitHub issues.
