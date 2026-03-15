import { test, expect } from '../fixtures/app.fixture.ts';

// NOTE: This app uses keyboard/gamepad input system.
// Escape key = back navigation (equivalent of "right click back" in plans).

test.describe('Back Navigation (Escape)', () => {
	test('Escape acts as back from submenu', async ({ appPage: page }) => {
		// Navigate into Settings
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('Settings');

		// Escape to go back
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);

		const buttons = page.locator('.content .menu .button');
		await expect(buttons).toHaveCount(6);
	});

	test('Escape at main menu navigates to Exit submenu', async ({ appPage: page }) => {
		// At main menu, Escape should navigate to Exit
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);

		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('Exit');
	});

	test('double Escape from Settings goes back to main menu', async ({ appPage: page }) => {
		// Navigate into Settings > Time
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Go to Time (5th item in settings, index 4)
		for (let i = 0; i < 4; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Double Escape
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);

		const buttons = page.locator('.content .menu .button');
		await expect(buttons).toHaveCount(6);
	});
});
