import { defineConfig } from 'vitest/config';

// Integration tests run against a separate database in the dev Postgres container.
const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://carbooking:carbooking@localhost:5433/carbooking_test?schema=public';

export default defineConfig({
  test: {
    env: { DATABASE_URL: TEST_DB, AUTH_MODE: 'dev', NODE_ENV: 'test', APP_SECRET: 'test-secret-test-secret', STORAGE_LOCAL_DIR: '/tmp/carbooking-test-storage', CRM_API_URL: 'http://crm.test', CRM_API_TOKEN: 'crm-test-token-crm-test-token-0001' },
    globalSetup: './test/global-setup.ts',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
