import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: './tests/e2e/specs',
	fullyParallel: false,
	forbidOnly: !!process.env['CI'],
	retries: process.env['CI'] ? 1 : 0,
	workers: 1,
	reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
	timeout: 30_000,
	expect: { timeout: 10_000 },
	use: {
		baseURL: 'http://localhost:6003',
		trace: 'on-first-retry',
		screenshot: 'only-on-failure',
		video: 'off',
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
	webServer: [
		{
			command: 'npx tsx tests/e2e/fixtures/mock-backend.ts',
			port: 1158,
			reuseExistingServer: !process.env['CI'],
			timeout: 10_000,
		},
		{
			command: 'npm run dev -- --port 6003',
			port: 6003,
			reuseExistingServer: !process.env['CI'],
			timeout: 30_000,
			env: {
				VITE_BACKEND_URL: 'ws://localhost:1158',
			},
		},
	],
});
