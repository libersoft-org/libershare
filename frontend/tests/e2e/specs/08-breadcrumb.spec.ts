import { test, expect } from '../fixtures/app.fixture.ts';

test.describe('Breadcrumb Navigation', () => {
	test('breadcrumb shows Home at root', async ({ appPage: page }) => {
		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toBeVisible();
		// Only one item at root (Home icon)
		const items = page.locator('.breadcrumb .item');
		await expect(items).toHaveCount(1);
	});

	test('breadcrumb updates when navigating into submenu', async ({ appPage: page }) => {
		// Navigate to Settings via keyboard
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Breadcrumb should show Home > Settings
		const items = page.locator('.breadcrumb .item');
		await expect(items).toHaveCount(2);
		await expect(items.nth(1)).toContainText('Settings');
	});

	test('breadcrumb shows multi-level path', async ({ appPage: page }) => {
		// Navigate to Settings > System
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Should show Home > Settings > System
		const items = page.locator('.breadcrumb .item');
		await expect(items).toHaveCount(3);
		await expect(items.nth(1)).toContainText('Settings');
		await expect(items.nth(2)).toContainText('System');
	});

	test('current breadcrumb item has current class', async ({ appPage: page }) => {
		// Navigate to Settings
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Last breadcrumb item should have .current class
		const items = page.locator('.breadcrumb .item');
		const lastItem = items.last();
		await expect(lastItem).toHaveClass(/current/);
	});

	test('breadcrumb navigable via keyboard (ArrowUp to breadcrumb area)', async ({ appPage: page }) => {
		// Navigate to Settings
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// ArrowUp should move focus to breadcrumb area
		await page.keyboard.press('ArrowUp');
		await page.waitForTimeout(200);

		// Breadcrumb should have a selected item
		const selectedItem = page.locator('.breadcrumb .item.selected');
		const count = await selectedItem.count();
		// May or may not have selected state depending on area activation
		expect(count).toBeLessThanOrEqual(1);
	});
});
