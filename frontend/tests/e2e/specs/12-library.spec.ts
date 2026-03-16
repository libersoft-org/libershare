import { test, expect } from '../fixtures/app.fixture.ts';

test.describe('Library (Online Library)', () => {
	test.beforeEach(async ({ appPage: page }) => {
		// Navigate to Library (first menu item)
		await page.keyboard.press('Enter');
		await page.waitForTimeout(800);
	});

	test('shows library page with breadcrumb', async ({ appPage: page }) => {
		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('Online library');
	});

	test('shows search bar', async ({ appPage: page }) => {
		const searchInput = page.locator('.search input');
		await expect(searchInput).toBeVisible();
	});

	test('shows Publish and Permissions toolbar buttons', async ({ appPage: page }) => {
		await expect(page.getByText('Publish')).toBeVisible();
		await expect(page.getByText('Permissions')).toBeVisible();
	});

	test('shows catalog entries from mock backend', async ({ appPage: page }) => {
		// Mock backend returns 4 entries
		const items = page.locator('.catalog-content .items .item');
		await expect(items.first()).toBeVisible({ timeout: 5000 });
		await expect(items).toHaveCount(4);
	});

	test('shows network name in status bar', async ({ appPage: page }) => {
		await expect(page.locator('.status-text')).toContainText('Test Network');
		await expect(page.locator('.status-text')).toContainText('4 entries');
	});

	test('navigate back to main menu via Escape', async ({ appPage: page }) => {
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);
		const buttons = page.locator('.content .menu .button');
		await expect(buttons).toHaveCount(6);
	});
});
