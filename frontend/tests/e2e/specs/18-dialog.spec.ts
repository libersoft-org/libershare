import { test, expect } from '../fixtures/app.fixture.ts';

test.describe('Dialog Component', () => {
	test('About dialog renders with correct structure', async ({ appPage: page }) => {
		// Navigate to About to trigger a Dialog
		for (let i = 0; i < 4; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Dialog should have wrapper, dialog box, title, and body
		const wrapper = page.locator('.dialog-wrapper');
		await expect(wrapper).toBeVisible();

		const dialog = page.locator('.dialog');
		await expect(dialog).toBeVisible();

		const title = page.locator('.dialog .title');
		await expect(title).toBeVisible();
		await expect(title).toHaveText('LiberShare');

		const body = page.locator('.dialog .body');
		await expect(body).toBeVisible();
	});

	test('Confirm dialog renders with Yes/No buttons', async ({ appPage: page }) => {
		// Navigate to Exit > Restart to trigger ConfirmDialog
		for (let i = 0; i < 5; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Select Restart
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Confirm dialog should appear
		const confirmMessage = page.locator('.confirm .message');
		await expect(confirmMessage).toBeVisible();
		await expect(confirmMessage).toContainText('Are you sure');

		// Should have Yes and No buttons
		const yesBtn = page.locator('.confirm .button', { hasText: 'Yes' });
		const noBtn = page.locator('.confirm .button', { hasText: 'No' });
		await expect(yesBtn).toBeVisible();
		await expect(noBtn).toBeVisible();
	});

	test('Confirm dialog No button cancels', async ({ appPage: page }) => {
		// Navigate to Exit > Quit
		for (let i = 0; i < 5; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Navigate to Quit (3rd in exit submenu)
		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(100);
		await page.keyboard.press('ArrowRight');
		await page.waitForTimeout(100);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Press Enter on No button (default selected)
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		// Should be back at exit submenu
		const breadcrumb = page.locator('.breadcrumb');
		await expect(breadcrumb).toContainText('Exit');
	});

	test('dialog has fixed overlay positioning', async ({ appPage: page }) => {
		// Open About dialog
		for (let i = 0; i < 4; i++) {
			await page.keyboard.press('ArrowRight');
			await page.waitForTimeout(100);
		}
		await page.keyboard.press('Enter');
		await page.waitForTimeout(300);

		const wrapper = page.locator('.dialog-wrapper');
		const position = await wrapper.evaluate(el => getComputedStyle(el).position);
		expect(position).toBe('fixed');
	});
});
