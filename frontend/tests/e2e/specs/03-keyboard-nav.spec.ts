import { test, expect } from '../fixtures/app.fixture.ts';

test.describe('Keyboard Navigation', () => {
	test('arrow right moves selection to next menu item', async ({ appPage: page }) => {
		const buttons = page.locator('.content .menu .button');
		// First button should be selected
		await expect(buttons.nth(0)).toHaveClass(/selected/);

		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(150);

		await expect(buttons.nth(1)).toHaveClass(/selected/);
		await expect(buttons.nth(0)).not.toHaveClass(/selected/);
	});

	test('arrow left moves selection to previous menu item', async ({ appPage: page }) => {
		const buttons = page.locator('.content .menu .button');
		// Move right first, then left
		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(150);
		await page.keyboard.press('ArrowLeft');
		await page.waitForTimeout(150);

		await expect(buttons.nth(0)).toHaveClass(/selected/);
	});

	test('arrow right wraps or stops at last item', async ({ appPage: page }) => {
		const buttons = page.locator('.content .menu .button');
		// Press right 5 times to reach last item (Exit)
		for (let i = 0; i < 5; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await expect(buttons.nth(5)).toHaveClass(/selected/);

		// One more right should not crash (either wraps or stays)
		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(100);
		// Should still have a selected button
		const selectedCount = await page.locator('.content .menu .button.selected').count();
		expect(selectedCount).toBe(1);
	});

	test('Enter navigates into selected menu item', async ({ appPage: page }) => {
		// Select Settings (index 3)
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Should show Settings submenu items
		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('Settings');
	});

	test('Escape goes back from submenu', async ({ appPage: page }) => {
		// Navigate into Settings
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Escape should go back
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);

		// Should be back at main menu with 6 items
		const buttons = page.locator('.content .menu .button');
		await expect(buttons).toHaveCount(6);
	});

	test('arrow down moves to content area from header', async ({ appPage: page }) => {
		// Press up to move to header area
		await page.keyboard.press('ArrowUp');
		await page.waitForTimeout(150);

		// Press down to get back to content
		await page.keyboard.press('ArrowDown');
		await page.waitForTimeout(150);

		// Content area buttons should have a selected state
		const selected = page.locator('.content .button.selected');
		await expect(selected).toHaveCount(1);
	});
});
