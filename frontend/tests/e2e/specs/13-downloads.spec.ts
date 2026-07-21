import { test, expect } from '../fixtures/app.fixture.ts';

test.describe('Downloads', () => {
	test.beforeEach(async ({ appPage: page }) => {
		// Navigate to Downloads (3rd item, index 2)
		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(100);
		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(100);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);
	});

	test('shows downloads page', async ({ appPage: page }) => {
		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('Downloads');
	});

	test('downloads page has submenu items', async ({ appPage: page }) => {
		// Downloads submenu: Create LISH, Import, Export all, Back (+ hidden download-detail)
		const buttons = page.locator('.content .button');
		const count = await buttons.count();
		expect(count).toBeGreaterThanOrEqual(3);
	});

	test('navigate to Create LISH', async ({ appPage: page }) => {
		// Create LISH should be first option
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('Create LISH');
	});

	test('escape goes back from downloads', async ({ appPage: page }) => {
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);

		const buttons = page.locator('.content .menu .button');
		await expect(buttons).toHaveCount(6);
	});
});
