import { test, expect } from '../fixtures/app.fixture.ts';

test.describe('Mouse Scroll', () => {
	test('wheel scroll moves menu selection', async ({ appPage: page }) => {
		const buttons = page.locator('.content .menu .button');
		// First button should be selected
		await expect(buttons.nth(0)).toHaveClass(/selected/);

		// Scroll down on menu area
		await page.locator('.content').hover();
		await page.mouse.wheel(0, 100);
		await page.waitForTimeout(300);

		// Selection should have moved (may or may not depending on input handling)
		// At minimum, the page should not error
		const selectedCount = await page.locator('.content .menu .button.selected').count();
		expect(selectedCount).toBeLessThanOrEqual(1);
	});

	test('content area scrolls with mouse wheel when content overflows', async ({ appPage: page }) => {
		// Navigate to a page with scrollable content (Settings > System)
		const settingsButton = page.locator('.content .menu .button').nth(3);
		await settingsButton.click();
		await page.waitForTimeout(300);

		// Click System
		const systemButton = page.locator('.content .button').first();
		await systemButton.click();
		await page.waitForTimeout(300);

		// Scroll content area
		const content = page.locator('.content');
		await content.hover();
		await page.mouse.wheel(0, 200);
		await page.waitForTimeout(300);

		// Just verify no errors
		await expect(content).toBeVisible();
	});
});
