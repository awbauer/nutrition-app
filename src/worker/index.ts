import { app } from './app';
import type { Env } from './env';

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext) {
    // Reminder dispatch arrives in phase 5.
  },
} satisfies ExportedHandler<Env>;
