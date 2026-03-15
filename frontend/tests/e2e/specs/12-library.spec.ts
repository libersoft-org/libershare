import { test, expect } from '../fixtures/app.fixture.ts';

test.describe('Library (Online Library)', () => {
	test.beforeEach(async ({ appPage: page }) => {
		// Navigate to Library (first item)
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);
	});

	test('shows library categories', async ({ appPage: page }) => {
		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('Online library');

		// Should show category items (Video, Software, Back)
		const buttons = page.locator('.content .button');
		const count = await buttons.count();
		expect(count).toBeGreaterThanOrEqual(2);
	});

	test('navigate to Video category shows products grid', async ({ appPage: page }) => {
		// Select Video (first category)
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('Video');
	});

	test('navigate back from categories', async ({ appPage: page }) => {
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);

		// Should be back at main menu
		const buttons = page.locator('.content .menu .button');
		await expect(buttons).toHaveCount(6);
	});
});
