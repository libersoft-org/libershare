import { test, expect } from '../fixtures/app.fixture.ts';

test.describe('Settings - Language', () => {
	test.beforeEach(async ({ appPage: page }) => {
		// Navigate to Settings > Language using keyboard
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);
		// Language is 4th item in Settings horizontal menu (index 3)
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);
	});

	test('shows language options', async ({ appPage: page }) => {
		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('Language');

		// Should show language buttons (English, Čeština, Back)
		const buttons = page.locator('.content .button');
		const count = await buttons.count();
		expect(count).toBeGreaterThanOrEqual(3);
	});

	test('displays English and Czech options', async ({ appPage: page }) => {
		const pageContent = page.locator('.content');
		await expect(pageContent).toContainText('English');
		await expect(pageContent).toContainText('Čeština');
	});

	test('selecting Czech changes UI language', async ({ appPage: page }) => {
		// Čeština is second item - ArrowRight once, then Enter
		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(100);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		// After selecting language, it navigates back to Settings
		// Settings breadcrumb should now show Czech translation "Nastavení"
		const breadcrumb = page.locator('.breadcrumb');
		const breadcrumbText = await breadcrumb.textContent();
		expect(breadcrumbText).toContain('Nastavení');

		// Reset back to English: navigate to Language again (4th item, index 3)
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// English is first item, Enter to select
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);
	});
});
