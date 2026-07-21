import { test, expect } from '../fixtures/app.fixture.ts';

test.describe('Footer', () => {
	test('footer is visible', async ({ appPage: page }) => {
		const footer = page.locator('.footer');
		await expect(footer).toBeVisible();
	});

	test('footer shows clock widget', async ({ appPage: page }) => {
		const footer = page.locator('.footer');
		// Clock should display time (contains : separator)
		const footerText = await footer.textContent();
		expect(footerText).toMatch(/\d{1,2}:\d{2}/);
	});

	test('footer shows volume widget', async ({ appPage: page }) => {
		const footer = page.locator('.footer');
		await expect(footer).toContainText('50%');
	});

	test('footer shows download/upload widgets', async ({ appPage: page }) => {
		const footer = page.locator('.footer');
		await expect(footer).toContainText('MB/s');
	});

	test('footer shows LISH status', async ({ appPage: page }) => {
		const footer = page.locator('.footer');
		await expect(footer).toContainText('LISH');
	});

	test('footer has right position by default', async ({ appPage: page }) => {
		const footer = page.locator('.footer');
		await expect(footer).toHaveClass(/right/);
	});
});
