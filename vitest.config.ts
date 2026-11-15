import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        remoteBindings: false,
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, DEV_AUTH: '1', DEV_USER_EMAIL: 'test@example.test', USDA_API_KEY: 'test-key', AI_GATEWAY_ID: 'nutrition', USDA_BASE_URL: '' },
        },
      }),
    ],
    test: { setupFiles: ['./test/setup.ts'], include: ['test/**/*.test.ts'] },
  };
});
