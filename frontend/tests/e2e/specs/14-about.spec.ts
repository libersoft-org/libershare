import { test, expect } from '../fixtures/app.fixture.ts';
import { PRODUCT_NAME, PRODUCT_VERSION } from '../fixtures/constants.ts';

test.describe('About', () => {
	test.beforeEach(async ({ appPage: page }) => {
		// Navigate to About (5th item, index 4) using keyboard
		for (let i = 0; i < 4; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);
	});

	test('shows About dialog', async ({ appPage: page }) => {
		const dialog = page.locator('.dialog');
		await expect(dialog).toBeVisible();
	});

	test('About dialog shows product name', async ({ appPage: page }) => {
		const dialog = page.locator('.dialog');
		await expect(dialog).toContainText(PRODUCT_NAME);
	});

	test('About dialog shows version', async ({ appPage: page }) => {
		const dialog = page.locator('.dialog');
		await expect(dialog).toContainText(PRODUCT_VERSION);
	});

	test('About dialog shows build date and commit', async ({ appPage: page }) => {
		const dialog = page.locator('.dialog');
		await expect(dialog).toContainText('Build date');
		await expect(dialog).toContainText('Commit');
	});

	test('About dialog has GitHub and Website buttons', async ({ appPage: page }) => {
		const content = page.locator('.content');
		await expect(content).toContainText('GitHub page');
		await expect(content).toContainText('Official website');
	});

	test('About dialog has OK button', async ({ appPage: page }) => {
		const content = page.locator('.content');
		await expect(content).toContainText('OK');
	});

	test('OK button closes About dialog via keyboard', async ({ appPage: page }) => {
		// OK button should be selected by default (initialIndex=2 in About.svelte)
		// Press Enter to confirm OK
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Should be back at main menu
		const buttons = page.locator('.content .menu .button');
		await expect(buttons).toHaveCount(6);
	});

	test('Escape closes About dialog', async ({ appPage: page }) => {
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);

		const buttons = page.locator('.content .menu .button');
		await expect(buttons).toHaveCount(6);
	});
});
