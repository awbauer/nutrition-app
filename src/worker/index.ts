import { app } from './app';
import type { Env } from './env';
import { dispatchReminders } from './lib/reminders';

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      dispatchReminders(env, new Date(controller.scheduledTime)).then((r) => {
        if (r.sent || r.skipped || r.removed) console.log('reminders', r);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
