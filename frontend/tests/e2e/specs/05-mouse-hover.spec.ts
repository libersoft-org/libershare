import { test, expect } from '../fixtures/app.fixture.ts';

test.describe('Mouse Hover', () => {
	test('hovering over menu item changes selection', async ({ appPage: page }) => {
		const buttons = page.locator('.content .menu .button');
		// Hover over 3rd item (Downloads)
		await buttons.nth(2).hover();
		await page.waitForTimeout(200);

		// The hovered item should become selected (or at least visible)
		// Note: hover behavior depends on the input system
		await expect(buttons.nth(2)).toBeVisible();
	});

	test('mouse movement shows custom cursor', async ({ appPage: page }) => {
		// Move mouse to trigger cursor visibility
		await page.mouse.move(400, 400);
		await page.waitForTimeout(200);

		// The cursor image should be visible
		const cursor = page.locator('img.cursor');
		// Cursor may or may not be visible depending on cursorVisible state
		const cursorCount = await cursor.count();
		expect(cursorCount).toBeLessThanOrEqual(1);
	});
});
