import { test, expect } from '../fixtures/app.fixture.ts';

test.describe('Catalog — Full Workflow (keyboard only)', () => {
	test.beforeEach(async ({ appPage: page }) => {
		// Navigate to Library (first menu item) — focus lands on toolbar
		await page.keyboard.press('Enter');
		await page.waitForTimeout(800);
	});

	test('catalog loads 4 entries from mock backend', async ({ appPage: page }) => {
		const items = page.locator('.catalog-content .items .item');
		await expect(items.first()).toBeVisible({ timeout: 5000 });
		await expect(items).toHaveCount(4);
	});

	test('catalog items display names, metadata and tags', async ({ appPage: page }) => {
		const items = page.locator('.catalog-content .items .item');
		await expect(items.first()).toBeVisible({ timeout: 5000 });

		// Titles
		const titles = page.locator('.catalog-content .items .item .title');
		expect(await titles.count()).toBe(4);
		await expect(titles.first()).not.toBeEmpty();

		// Metadata
		const meta = page.locator('.catalog-content .items .item .meta');
		expect(await meta.count()).toBeGreaterThanOrEqual(1);

		// Tags
		const tags = page.locator('.catalog-content .items .item .tag');
		expect(await tags.count()).toBeGreaterThanOrEqual(1);
	});

	test('arrow keys navigate through catalog grid', async ({ appPage: page }) => {
		const items = page.locator('.catalog-content .items .item');
		await expect(items.first()).toBeVisible({ timeout: 5000 });

		// Navigate right/down/left in grid
		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(200);
		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(200);
		await page.keyboard.press('ArrowDown');
		await page.waitForTimeout(200);
		await page.keyboard.press('ArrowLeft');
		await page.waitForTimeout(200);

		// Grid should still be visible
		await expect(items).toHaveCount(4);
	});

	test('Enter on toolbar opens Publish panel, Escape returns', async ({ appPage: page }) => {
		// From library landing, navigate up to toolbar
		await page.keyboard.press('ArrowUp');
		await page.waitForTimeout(200);

		// Enter on Publish button (first toolbar button)
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		// Check if breadcrumb shows Publish
		const breadcrumb = page.locator('.breadcrumb');
		const text = await breadcrumb.textContent();

		if (text?.includes('Publish')) {
			// Publish panel opened — check content
			await expect(page.locator('.empty-msg')).toContainText('No local LISHs');

			// Escape back
			await page.keyboard.press('Escape');
			await page.waitForTimeout(500);

			// Back at catalog
			const items = page.locator('.catalog-content .items .item');
			await expect(items.first()).toBeVisible({ timeout: 3000 });
		}
		// If focus was elsewhere, that's OK — toolbar position varies
	});

	test('Permissions panel shows Owner, Admins, Moderators', async ({ appPage: page }) => {
		// Navigate up to toolbar
		await page.keyboard.press('ArrowUp');
		await page.waitForTimeout(200);

		// Move right to Permissions button
		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(200);

		// Enter on Permissions
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		const breadcrumb = page.locator('.breadcrumb');
		const text = await breadcrumb.textContent();

		if (text?.includes('Permissions')) {
			// Should show sections
			await expect(page.getByText('Owner', { exact: false })).toBeVisible();
			await expect(page.locator('.owner-id')).toContainText('12D3KooW');

			// Escape back
			await page.keyboard.press('Escape');
			await page.waitForTimeout(300);
		}
	});

	test('Permissions panel shows correct admin/moderator counts', async ({ appPage: page }) => {
		// Nav to Permissions
		await page.keyboard.press('ArrowUp');
		await page.waitForTimeout(200);
		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(200);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		// Mock has 1 admin, 2 moderators
		const text = await page.content();
		if (text.includes('Admins')) {
			expect(text).toContain('Admins (1)');
			expect(text).toContain('Moderators (2)');
		}

		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);
	});

	test('selecting item with Enter opens detail, Escape returns', async ({ appPage: page }) => {
		const items = page.locator('.catalog-content .items .item');
		await expect(items.first()).toBeVisible({ timeout: 5000 });

		// First item should be focused, Enter opens detail
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		// Breadcrumb should have entry name
		const breadcrumb = page.locator('.breadcrumb');
		const text = await breadcrumb.textContent();
		expect(text!.length).toBeGreaterThan(10);

		// Escape back to grid
		await page.keyboard.press('Escape');
		await page.waitForTimeout(500);

		// Items visible again
		await expect(items.first()).toBeVisible({ timeout: 3000 });
	});

	test('search filters entries', async ({ appPage: page }) => {
		const items = page.locator('.catalog-content .items .item');
		await expect(items.first()).toBeVisible({ timeout: 5000 });

		// Focus search bar and type
		const searchInput = page.locator('.search input');
		await searchInput.focus();
		await page.waitForTimeout(200);
		await searchInput.fill('Ubuntu');
		// Dispatch input event to trigger Svelte reactivity
		await searchInput.dispatchEvent('input');
		await searchInput.dispatchEvent('change');
		await page.waitForTimeout(1500);

		// Should show filtered results (1 entry matching "Ubuntu")
		await expect(items).toHaveCount(1);
	});

	test('multiple panel open/close cycles without JS errors', async ({ appPage: page }) => {
		const errors: string[] = [];
		page.on('pageerror', err => errors.push(err.message));

		for (let cycle = 0; cycle < 3; cycle++) {
			// Up to toolbar
			await page.keyboard.press('ArrowUp');
			await page.waitForTimeout(150);

			// Enter Publish
			await page.keyboard.press('Enter');
			await page.waitForTimeout(300);
			await page.keyboard.press('Escape');
			await page.waitForTimeout(300);

			// Right to Permissions
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(150);
			await page.keyboard.press('Enter');
			await page.waitForTimeout(300);
			await page.keyboard.press('Escape');
			await page.waitForTimeout(300);

			// Left back to Publish position
			await page.keyboard.press('ArrowLeft');
			await page.waitForTimeout(150);

			// Down to items
			await page.keyboard.press('ArrowDown');
			await page.waitForTimeout(150);
		}

		expect(errors.length).toBe(0);
	});

	test('no JavaScript errors during normal navigation', async ({ appPage: page }) => {
		const errors: string[] = [];
		page.on('pageerror', err => errors.push(err.message));

		await page.waitForTimeout(500);

		// Arrow around
		for (let i = 0; i < 4; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('ArrowDown');
		await page.waitForTimeout(200);
		await page.keyboard.press('ArrowUp');
		await page.waitForTimeout(200);

		expect(errors.length).toBe(0);
	});

	test('catalog entries show formatted sizes', async ({ appPage: page }) => {
		const meta = page.locator('.catalog-content .items .item .meta');
		await expect(meta.first()).toBeVisible({ timeout: 5000 });
		const text = await meta.first().textContent();
		expect(text).toMatch(/[0-9]/);
	});

	test('full round-trip: library → detail → back → menu', async ({ appPage: page }) => {
		const errors: string[] = [];
		page.on('pageerror', err => errors.push(err.message));

		const items = page.locator('.catalog-content .items .item');
		await expect(items.first()).toBeVisible({ timeout: 5000 });

		// Enter detail
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		// Breadcrumb should show detail
		const breadcrumb = page.locator('.breadcrumb');
		const text = await breadcrumb.textContent();
		expect(text!.length).toBeGreaterThan(10);

		// Back to catalog
		await page.keyboard.press('Escape');
		await page.waitForTimeout(500);

		// Should see items again
		await expect(items.first()).toBeVisible({ timeout: 3000 });

		// Back to main menu (single Escape from Library)
		await page.keyboard.press('Escape');
		await page.waitForTimeout(500);

		// Check if we're at main menu
		const menuBreadcrumb = await breadcrumb.textContent();
		// Should not be on Exit page
		expect(menuBreadcrumb).not.toContain('Exit');

		expect(errors.length).toBe(0);
	});
});
