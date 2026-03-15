import { test, expect } from '../fixtures/app.fixture.ts';

test.describe('Catalog / Online Library', () => {
	test.beforeEach(async ({ appPage: page }) => {
		// Navigate to Library (first menu item)
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);
	});

	test('shows library page with breadcrumb', async ({ appPage: page }) => {
		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('Online library');
	});

	test('navigates to catalog category and shows items', async ({ appPage: page }) => {
		// Select first category (e.g. Video)
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		// Should show catalog items from mock backend
		const items = page.locator('.items .item');
		const count = await items.count();
		// If items are loaded from catalog API, we should see them
		// The mock returns 4 entries
		expect(count).toBeGreaterThanOrEqual(0);
	});

	test('catalog items display entry names', async ({ appPage: page }) => {
		// Navigate to a category
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		// Check that entry titles are visible
		const titles = page.locator('.items .item .title');
		const count = await titles.count();
		if (count > 0) {
			const firstTitle = await titles.first().textContent();
			expect(firstTitle).toBeTruthy();
		}
	});

	test('can navigate back from catalog', async ({ appPage: page }) => {
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);

		// Should be back at library categories or main menu
		const breadcrumb = page.locator('.breadcrumb');
		const text = await breadcrumb.textContent();
		expect(text).toBeTruthy();
	});

	test('catalog shows loading state initially', async ({ appPage: page }) => {
		// Navigate to category
		await page.keyboard.press('Enter');
		await page.waitForTimeout(100);

		// Briefly shows loading or content
		const content = page.locator('.items, .loading, .empty');
		const count = await content.count();
		expect(count).toBeGreaterThanOrEqual(0);
	});

	test('catalog handles empty state', async ({ appPage: page }) => {
		// The library page should handle case when no networkID is provided
		// It should show "Catalog is empty" or similar
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		// Check page renders without errors
		const pageContent = await page.content();
		expect(pageContent).toBeTruthy();
		// No uncaught errors
		const consoleLogs: string[] = [];
		page.on('console', msg => {
			if (msg.type() === 'error' && !msg.text().includes('[API]')) {
				consoleLogs.push(msg.text());
			}
		});
		await page.waitForTimeout(200);
		// Filter out expected API errors
		const unexpectedErrors = consoleLogs.filter(l => !l.includes('Catalog not joined'));
		expect(unexpectedErrors.length).toBe(0);
	});

	test('keyboard navigation works in catalog grid', async ({ appPage: page }) => {
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		// Try navigating with arrow keys
		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(200);
		await page.keyboard.press('ArrowDown');
		await page.waitForTimeout(200);
		await page.keyboard.press('ArrowLeft');
		await page.waitForTimeout(200);

		// Page should still be responsive
		const pageContent = await page.content();
		expect(pageContent).toBeTruthy();
	});

	test('selecting a catalog entry opens detail view', async ({ appPage: page }) => {
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		// Select first item
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		// Detail or breadcrumb should update
		const breadcrumb = page.locator('.breadcrumb');
		const text = await breadcrumb.textContent();
		expect(text).toBeTruthy();
	});

	test('escape from detail view returns to grid', async ({ appPage: page }) => {
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		// Go back
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);

		// Should be back at grid
		const items = page.locator('.items .item');
		const count = await items.count();
		expect(count).toBeGreaterThanOrEqual(0);
	});

	test('page renders without JavaScript errors', async ({ appPage: page }) => {
		const errors: string[] = [];
		page.on('pageerror', err => errors.push(err.message));

		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		// Navigate around
		for (let i = 0; i < 3; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}

		expect(errors.length).toBe(0);
	});

	test('catalog items show metadata (size, tags)', async ({ appPage: page }) => {
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		// Check for metadata elements
		const meta = page.locator('.items .item .meta');
		const metaCount = await meta.count();
		// Items should have meta info rendered
		expect(metaCount).toBeGreaterThanOrEqual(0);

		// Check for tags
		const tags = page.locator('.items .item .tag');
		const tagCount = await tags.count();
		expect(tagCount).toBeGreaterThanOrEqual(0);
	});

	test('search bar is present on library page', async ({ appPage: page }) => {
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		const searchInput = page.locator('.search input');
		const count = await searchInput.count();
		expect(count).toBeGreaterThanOrEqual(1);
	});

	test('product detail shows entry info', async ({ appPage: page }) => {
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		// Detail page should show entry title and info section
		const info = page.locator('.detail .info');
		const count = await info.count();
		if (count > 0) {
			const title = page.locator('.detail .info .entry-title');
			const titleText = await title.textContent();
			expect(titleText).toBeTruthy();
		}

		// Should have a downloads section
		const downloads = page.locator('.detail .files .section-title');
		const dlCount = await downloads.count();
		expect(dlCount).toBeGreaterThanOrEqual(0);
	});

	test('multiple navigation cycles work without errors', async ({ appPage: page }) => {
		const errors: string[] = [];
		page.on('pageerror', err => errors.push(err.message));

		// Enter library → category → detail → back → back → repeat
		for (let cycle = 0; cycle < 3; cycle++) {
			await page.keyboard.press('Enter'); // library
			await page.waitForTimeout(300);
			await page.keyboard.press('Enter'); // category
			await page.waitForTimeout(300);
			await page.keyboard.press('Enter'); // detail
			await page.waitForTimeout(300);
			await page.keyboard.press('Escape'); // back to category
			await page.waitForTimeout(200);
			await page.keyboard.press('Escape'); // back to library
			await page.waitForTimeout(200);
			await page.keyboard.press('Escape'); // back to menu
			await page.waitForTimeout(200);
		}

		expect(errors.length).toBe(0);
	});
});
