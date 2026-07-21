import { test, expect } from '../fixtures/app.fixture.ts';

test.describe('Exit Dialog', () => {
	test.beforeEach(async ({ appPage: page }) => {
		// Navigate to Exit (6th item, index 5)
		for (let i = 0; i < 5; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);
	});

	test('shows exit submenu', async ({ appPage: page }) => {
		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('Exit');

		// Should show Restart, Shutdown, Quit, Back
		const buttons = page.locator('.content .button');
		const count = await buttons.count();
		expect(count).toBe(4);
	});

	test('exit submenu has correct labels', async ({ appPage: page }) => {
		const buttons = page.locator('.content .button');
		const texts = await buttons.allTextContents();
		const normalized = texts.map(t => t.trim());
		expect(normalized).toContain('Restart');
		expect(normalized).toContain('Shutdown');
		expect(normalized).toContain('Quit application');
		expect(normalized).toContain('Back');
	});

	test('selecting Restart shows confirm dialog', async ({ appPage: page }) => {
		// Select Restart (first item)
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Should show confirm dialog
		const dialog = page.locator('.content');
		await expect(dialog).toContainText('Are you sure');
	});

	test('cancel on confirm dialog returns to exit menu', async ({ appPage: page }) => {
		// Select Restart
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Press Escape to cancel
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);

		// Should be back at exit menu
		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('Exit');
	});

	test('Back in exit submenu returns to main menu', async ({ appPage: page }) => {
		// Navigate to Back (4th item)
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Should be back at main menu
		const buttons = page.locator('.content .menu .button');
		await expect(buttons).toHaveCount(6);
	});
});
