import { test as base, type Page } from '@playwright/test';

export const test = base.extend<{ appPage: Page }>({
	appPage: async ({ page }, use) => {
		await page.goto('/');
		await page.waitForSelector('.header .title', { timeout: 15_000 });
		await use(page);
	},
});

export { expect } from '@playwright/test';
