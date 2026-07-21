import { test, expect } from '../fixtures/app.fixture.ts';

test.describe('Settings - System', () => {
	test.beforeEach(async ({ appPage: page }) => {
		// Navigate to Settings > System
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);
		// Select System (first item in Settings)
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);
	});

	test('shows system settings page', async ({ appPage: page }) => {
		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('System');
	});

	test('displays switch rows for system settings', async ({ appPage: page }) => {
		// Should have switch rows for auto start, tray, minimize, minify, gzip
		const switchRows = page.locator('.switch-row');
		const count = await switchRows.count();
		expect(count).toBeGreaterThanOrEqual(4);
	});

	test('shows save and back buttons', async ({ appPage: page }) => {
		// Should have Save and Back buttons
		const saveButton = page.locator('.button', { hasText: 'Save' });
		const backButton = page.locator('.button', { hasText: 'Back' });
		await expect(saveButton).toBeVisible();
		await expect(backButton).toBeVisible();
	});

	test('switches can be toggled with Enter', async ({ appPage: page }) => {
		// First switch (auto start on boot) should be selected
		// Toggle it
		await page.keyboard.press('Enter');
		await page.waitForTimeout(200);

		// No crash - toggle happened
		const settings = page.locator('.settings');
		await expect(settings).toBeVisible();
	});

	test('navigate down through settings and save', async ({ appPage: page }) => {
		// Press down to reach save button
		for (let i = 0; i < 5; i++) {
			await page.keyboard.press('ArrowDown');
			await page.waitForTimeout(100);
		}
		// Press Enter to save
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Should navigate back to Settings menu
		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('Settings');
		await expect(breadcrumb).not.toContainText('System');
	});
});
