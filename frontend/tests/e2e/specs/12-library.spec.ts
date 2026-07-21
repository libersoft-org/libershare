import { test, expect } from '../fixtures/app.fixture.ts';

test.describe('Library (Online Library)', () => {
	test.beforeEach(async ({ appPage: page }) => {
		// Navigate to Library → Categories screen
		await page.keyboard.press('Enter');
		await page.waitForTimeout(800);
	});

	test('shows categories page with breadcrumb', async ({ appPage: page }) => {
		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('Online library');
	});

	test('shows category buttons (All, Movies, Software, Video, Back)', async ({ appPage: page }) => {
		await expect(page.getByText('All')).toBeVisible();
		await expect(page.getByText('Movies')).toBeVisible();
		await expect(page.getByText('Software')).toBeVisible();
		await expect(page.getByText('Video')).toBeVisible();
		await expect(page.getByText('Back')).toBeVisible();
	});

	test('selecting All category shows catalog entries', async ({ appPage: page }) => {
		// Enter "All" category
		await page.keyboard.press('Enter');
		await page.waitForTimeout(800);

		// Should see items
		const items = page.locator('.catalog-content .items .item');
		await expect(items).toHaveCount(4);
	});

	test('shows network name after entering category', async ({ appPage: page }) => {
		await page.keyboard.press('Enter');
		await page.waitForTimeout(800);
		await expect(page.locator('.status-text')).toContainText('Test Network');
	});

	test('navigate back from categories to main menu', async ({ appPage: page }) => {
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);
		const buttons = page.locator('.content .menu .button');
		await expect(buttons).toHaveCount(6);
	});

	test('navigate back from catalog to categories', async ({ appPage: page }) => {
		// Enter All category
		await page.keyboard.press('Enter');
		await page.waitForTimeout(800);
		// Back to categories
		await page.keyboard.press('Escape');
		await page.waitForTimeout(500);
		// Should see category buttons
		await expect(page.getByText('Movies')).toBeVisible();
	});
});
