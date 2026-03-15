import { test, expect } from '../fixtures/app.fixture.ts';
import { SETTINGS_SUBMENU_LABELS_EN } from '../fixtures/constants.ts';

test.describe('Settings - Submenus', () => {
	test.beforeEach(async ({ appPage: page }) => {
		// Navigate to Settings
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);
	});

	test('settings menu has correct number of items', async ({ appPage: page }) => {
		const buttons = page.locator('.content .button');
		const count = await buttons.count();
		// Should have System, Downloads, LISH Network, Language, Time, Footer, Audio, Cursor, Back = 9
		expect(count).toBe(9);
	});

	test('settings menu items have correct labels', async ({ appPage: page }) => {
		const buttons = page.locator('.content .button');
		const texts = await buttons.allTextContents();
		const normalized = texts.map(t => t.trim());
		expect(normalized).toEqual([...SETTINGS_SUBMENU_LABELS_EN]);
	});

	test('navigate to Time submenu', async ({ appPage: page }) => {
		// Time is 5th item (index 4)
		for (let i = 0; i < 4; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('Time');
	});

	test('navigate to Audio submenu', async ({ appPage: page }) => {
		// Audio is 7th item (index 6)
		for (let i = 0; i < 6; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('Sound effects');

		// Should show Yes/No options
		const yesBtn = page.locator('.content .button', { hasText: 'Yes' });
		const noBtn = page.locator('.content .button', { hasText: 'No' });
		await expect(yesBtn).toBeVisible();
		await expect(noBtn).toBeVisible();
	});

	test('navigate to Cursor size submenu', async ({ appPage: page }) => {
		// Cursor is 8th item (index 7)
		for (let i = 0; i < 7; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('Cursor size');

		// Should show Small/Medium/Large options
		const smallBtn = page.locator('.content .button', { hasText: 'Small' });
		const mediumBtn = page.locator('.content .button', { hasText: 'Medium' });
		const largeBtn = page.locator('.content .button', { hasText: 'Large' });
		await expect(smallBtn).toBeVisible();
		await expect(mediumBtn).toBeVisible();
		await expect(largeBtn).toBeVisible();
	});

	test('Back button in settings returns to main menu', async ({ appPage: page }) => {
		// Navigate to last item (Back)
		for (let i = 0; i < 8; i++) {
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
