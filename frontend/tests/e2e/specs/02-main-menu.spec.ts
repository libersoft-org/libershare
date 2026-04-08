import { test, expect } from '../fixtures/app.fixture.ts';
import { PRODUCT_NAME, MAIN_MENU_LABELS_EN } from '../fixtures/constants.ts';

test.describe('Main Menu', () => {
	test('header shows product name', async ({ appPage: page }) => {
		const title = page.locator('.header .title');
		await expect(title).toHaveText(PRODUCT_NAME);
	});

	test('renders 6 main menu items', async ({ appPage: page }) => {
		const buttons = page.locator('.content .menu .button');
		await expect(buttons).toHaveCount(6);
	});

	test('menu items have correct labels', async ({ appPage: page }) => {
		const buttons = page.locator('.content .menu .button');
		const texts = await buttons.allTextContents();
		// Texts may include whitespace, normalize
		const normalized = texts.map(t => t.trim());
		expect(normalized).toEqual([...MAIN_MENU_LABELS_EN]);
	});

	test('menu items have icons', async ({ appPage: page }) => {
		const icons = page.locator('.content .menu .button img');
		const count = await icons.count();
		expect(count).toBeGreaterThanOrEqual(6);
	});

	test('first menu item is selected by default', async ({ appPage: page }) => {
		const selectedButton = page.locator('.content .menu .button.selected');
		await expect(selectedButton).toHaveCount(1);
		const text = await selectedButton.textContent();
		expect(text?.trim()).toBe('Online library');
	});

	test('menu title shows product name', async ({ appPage: page }) => {
		// The menu has a title element inside .menu
		const menuTitle = page.locator('.content .menu .title');
		await expect(menuTitle).toHaveText(PRODUCT_NAME);
	});
});
