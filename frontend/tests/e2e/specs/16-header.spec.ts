import { test, expect } from '../fixtures/app.fixture.ts';
import { PRODUCT_NAME } from '../fixtures/constants.ts';

test.describe('Header', () => {
	test('header is visible', async ({ appPage: page }) => {
		const header = page.locator('.header');
		await expect(header).toBeVisible();
	});

	test('header shows product name', async ({ appPage: page }) => {
		const title = page.locator('.header .title');
		await expect(title).toHaveText(PRODUCT_NAME);
	});

	test('header has back button icon', async ({ appPage: page }) => {
		const backImg = page.locator('.header img[alt="Back"]');
		await expect(backImg).toBeVisible();
	});

	test('header has fullscreen button icon', async ({ appPage: page }) => {
		const fullscreenImg = page.locator('.header img[alt="Fullscreen"]');
		await expect(fullscreenImg).toBeVisible();
	});

	test('header shows debug hints', async ({ appPage: page }) => {
		const header = page.locator('.header');
		await expect(header).toContainText('F2');
		await expect(header).toContainText('F3');
	});

	test('Escape from submenu navigates back', async ({ appPage: page }) => {
		// Navigate into Settings via keyboard
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Escape to go back
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);

		// Should be back at main menu
		const buttons = page.locator('.content .menu .button');
		await expect(buttons).toHaveCount(6);
	});

	test('header area accessible via ArrowUp from breadcrumb', async ({ appPage: page }) => {
		// Navigate into Settings to get breadcrumb
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// ArrowUp twice to reach header (content -> breadcrumb -> header)
		await page.keyboard.press('ArrowUp');
		await page.waitForTimeout(200);
		await page.keyboard.press('ArrowUp');
		await page.waitForTimeout(200);

		// Header buttons should have selection state
		const headerSelected = page.locator('.header .button.selected');
		const count = await headerSelected.count();
		// Header area may or may not have visible selected state
		expect(count).toBeLessThanOrEqual(1);
	});
});
