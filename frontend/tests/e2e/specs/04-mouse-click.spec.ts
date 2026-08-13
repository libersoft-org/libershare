import { test, expect } from '../fixtures/app.fixture.ts';

// NOTE: This app uses custom input system (keyboard/gamepad only).
// Mouse clicks on buttons don't trigger navigation.
// Tests use keyboard Enter to simulate "confirm" action.

test.describe('Mouse Click / Confirm Navigation', () => {
	test('Enter on menu item navigates into it', async ({ appPage: page }) => {
		// Navigate to Settings (4th item)
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('Settings');
	});

	test('Escape navigates back from submenu', async ({ appPage: page }) => {
		// Navigate into Settings
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Escape goes back
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);

		const buttons = page.locator('.content .menu .button');
		await expect(buttons).toHaveCount(6);
	});

	test('Enter on About shows About dialog', async ({ appPage: page }) => {
		// Navigate to About (5th item, index 4)
		for (let i = 0; i < 4; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		const dialog = page.locator('.dialog');
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText('LiberShare');
	});

	test('keyboard navigation through breadcrumb levels', async ({ appPage: page }) => {
		// Navigate Settings > System
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Verify breadcrumb shows System
		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('System');

		// Escape back twice to main menu
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);

		const buttons = page.locator('.content .menu .button');
		await expect(buttons).toHaveCount(6);
	});
});
