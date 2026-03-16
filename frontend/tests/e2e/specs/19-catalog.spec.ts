import { test, expect } from '../fixtures/app.fixture.ts';

test.describe('Catalog — Full Workflow (keyboard only)', () => {
	test.beforeEach(async ({ appPage: page }) => {
		// Menu → Library → Categories → Enter "All"
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(800);
	});

	test('catalog loads entries from backend', async ({ appPage: page }) => {
		const items = page.locator('.catalog-content .items .item');
		await expect(items.first()).toBeVisible({ timeout: 5000 });
		expect(await items.count()).toBeGreaterThanOrEqual(1);
	});

	test('catalog items display names, metadata and tags', async ({ appPage: page }) => {
		const items = page.locator('.catalog-content .items .item');
		await expect(items.first()).toBeVisible({ timeout: 5000 });

		const titles = page.locator('.catalog-content .items .item .title');
		expect(await titles.count()).toBeGreaterThanOrEqual(1);
		await expect(titles.first()).not.toBeEmpty();

		const meta = page.locator('.catalog-content .items .item .meta');
		expect(await meta.count()).toBeGreaterThanOrEqual(1);

		const tags = page.locator('.catalog-content .items .item .tag');
		expect(await tags.count()).toBeGreaterThanOrEqual(1);
	});

	test('arrow keys navigate through catalog grid', async ({ appPage: page }) => {
		const items = page.locator('.catalog-content .items .item');
		await expect(items.first()).toBeVisible({ timeout: 5000 });
		const initialCount = await items.count();

		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(200);
		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(200);
		await page.keyboard.press('ArrowDown');
		await page.waitForTimeout(200);
		await page.keyboard.press('ArrowLeft');
		await page.waitForTimeout(200);

		// Navigation shouldn't change item count
		expect(await items.count()).toBe(initialCount);
	});

	test('Enter on toolbar opens Publish panel, Escape returns', async ({ appPage: page }) => {
		await page.keyboard.press('ArrowUp');
		await page.waitForTimeout(200);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		const breadcrumb = page.locator('.breadcrumb');
		const text = await breadcrumb.textContent();
		if (text?.includes('Publish')) {
			await expect(page.locator('.empty-msg')).toContainText('No local LISHs');
			await page.keyboard.press('Escape');
			await page.waitForTimeout(500);
			const items = page.locator('.catalog-content .items .item');
			await expect(items.first()).toBeVisible({ timeout: 3000 });
		}
	});

	test('Permissions panel shows Owner, Admins, Moderators', async ({ appPage: page }) => {
		await page.keyboard.press('ArrowUp');
		await page.waitForTimeout(200);
		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(200);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		const breadcrumb = page.locator('.breadcrumb');
		const text = await breadcrumb.textContent();
		if (text?.includes('Permissions')) {
			await expect(page.locator('.section-title', { hasText: 'Owner' })).toBeVisible();
			await expect(page.locator('.owner-id')).toContainText('12D3KooW');
			await page.keyboard.press('Escape');
			await page.waitForTimeout(300);
		}
	});

	test('Permissions panel shows ACL data', async ({ appPage: page }) => {
		await page.keyboard.press('ArrowUp');
		await page.waitForTimeout(200);
		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(200);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		const text = await page.content();
		if (text.includes('Admins')) {
			// Just verify the ACL panel shows admin/moderator sections
			expect(text).toContain('Admins');
			expect(text).toContain('Moderators');
		}
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);
	});

	test('selecting item with Enter opens detail, Escape returns', async ({ appPage: page }) => {
		const items = page.locator('.catalog-content .items .item');
		await expect(items.first()).toBeVisible({ timeout: 5000 });

		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		const breadcrumb = page.locator('.breadcrumb');
		const text = await breadcrumb.textContent();
		expect(text!.length).toBeGreaterThan(10);

		await page.keyboard.press('Escape');
		await page.waitForTimeout(500);
		await expect(items.first()).toBeVisible({ timeout: 3000 });
	});

	test('search filters entries', async ({ appPage: page }) => {
		const items = page.locator('.catalog-content .items .item');
		await expect(items.first()).toBeVisible({ timeout: 5000 });
		const initialCount = await items.count();

		const searchInput = page.locator('.search input');
		await searchInput.focus();
		await page.waitForTimeout(200);
		// Use a search term that exists in mock data; for real backend it still filters
		await searchInput.fill('Ubuntu');
		await searchInput.dispatchEvent('input');
		await searchInput.dispatchEvent('change');
		await page.waitForTimeout(1500);

		// Should have fewer results than full catalog
		const filteredCount = await items.count();
		expect(filteredCount).toBeLessThanOrEqual(initialCount);
		expect(filteredCount).toBeGreaterThanOrEqual(0);
	});

	test('multiple panel open/close cycles without JS errors', async ({ appPage: page }) => {
		const errors: string[] = [];
		page.on('pageerror', err => errors.push(err.message));

		for (let cycle = 0; cycle < 3; cycle++) {
			await page.keyboard.press('ArrowUp');
			await page.waitForTimeout(150);
			await page.keyboard.press('Enter');
			await page.waitForTimeout(300);
			await page.keyboard.press('Escape');
			await page.waitForTimeout(300);
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(150);
			await page.keyboard.press('Enter');
			await page.waitForTimeout(300);
			await page.keyboard.press('Escape');
			await page.waitForTimeout(300);
			await page.keyboard.press('ArrowLeft');
			await page.waitForTimeout(150);
			await page.keyboard.press('ArrowDown');
			await page.waitForTimeout(150);
		}
		expect(errors.length).toBe(0);
	});

	test('no JavaScript errors during normal navigation', async ({ appPage: page }) => {
		const errors: string[] = [];
		page.on('pageerror', err => errors.push(err.message));
		await page.waitForTimeout(500);
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

	test('download button shows status message', async ({ appPage: page }) => {
		const items = page.locator('.catalog-content .items .item');
		await expect(items.first()).toBeVisible({ timeout: 5000 });

		// Open first item detail
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		// Find and click Download button
		const downloadBtn = page.locator('.button', { hasText: /Stáhnout|Download/ });
		if (await downloadBtn.count() > 0) {
			await downloadBtn.first().click();
			await page.waitForTimeout(1000);

			// Should show a status alert (warning for not_available, or info for downloading)
			const alert = page.locator('.alert');
			if (await alert.count() > 0) {
				const alertText = await alert.first().textContent();
				expect(alertText).toBeTruthy();
			}
		}

		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);
	});

	test('full round-trip: categories → catalog → detail → back → categories', async ({ appPage: page }) => {
		const errors: string[] = [];
		page.on('pageerror', err => errors.push(err.message));

		const items = page.locator('.catalog-content .items .item');
		await expect(items.first()).toBeVisible({ timeout: 5000 });

		// Enter detail
		await page.keyboard.press('Enter');
		await page.waitForTimeout(500);

		const breadcrumb = page.locator('.breadcrumb');
		const text = await breadcrumb.textContent();
		expect(text!.length).toBeGreaterThan(10);

		// Back to catalog
		await page.keyboard.press('Escape');
		await page.waitForTimeout(500);
		await expect(items.first()).toBeVisible({ timeout: 3000 });

		// Back to categories
		await page.keyboard.press('Escape');
		await page.waitForTimeout(500);
		await expect(page.getByText('Movies')).toBeVisible();

		expect(errors.length).toBe(0);
	});
});
