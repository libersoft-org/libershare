import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config that runs against a REAL backend (not mock).
 * Starts actual lish-backend with libp2p, SQLite, and catalog support.
 *
 * Usage: npx playwright test --config=playwright.real.config.ts tests/e2e/specs/19-catalog.spec.ts
 */
export default defineConfig({
	testDir: './tests/e2e/specs',
	fullyParallel: false,
	retries: 0,
	workers: 1,
	reporter: [['list'], ['html', { open: 'never' }]],
	timeout: 60_000,
	expect: { timeout: 15_000 },
	use: {
		baseURL: 'http://localhost:6004',
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
		video: 'off',
	},
	projects: [
		{
			name: 'chromium-real',
			use: { ...devices['Desktop Chrome'] },
		},
	],
	webServer: [
		{
			command: 'bun run ../backend/src/app.ts --datadir .playwright-real-data --port 1159 --host localhost',
			port: 1159,
			reuseExistingServer: true,
			timeout: 30_000,
		},
		{
			command: 'npm run dev -- --port 6004',
			port: 6004,
			reuseExistingServer: true,
			timeout: 30_000,
			env: {
				VITE_BACKEND_URL: 'ws://localhost:1159',
			},
		},
	],
});
