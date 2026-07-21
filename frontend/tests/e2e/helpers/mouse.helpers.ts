import type { Page, Locator } from '@playwright/test';

export async function hoverElement(page: Page, selector: string): Promise<void> {
	await page.hover(selector);
	await page.waitForTimeout(100);
}

export async function clickElement(page: Page, selector: string): Promise<void> {
	await page.click(selector);
	await page.waitForTimeout(100);
}

export async function rightClick(page: Page, selector: string): Promise<void> {
	await page.click(selector, { button: 'right' });
	await page.waitForTimeout(100);
}

export async function rightClickAt(page: Page, x: number, y: number): Promise<void> {
	await page.mouse.click(x, y, { button: 'right' });
	await page.waitForTimeout(100);
}

export async function wheelScroll(page: Page, deltaY: number, selector?: string): Promise<void> {
	if (selector) {
		const el = page.locator(selector);
		await el.hover();
	}
	await page.mouse.wheel(0, deltaY);
	await page.waitForTimeout(200);
}

export async function dragElement(locator: Locator, deltaX: number, deltaY: number): Promise<void> {
	const box = await locator.boundingBox();
	if (!box) return;
	const startX = box.x + box.width / 2;
	const startY = box.y + box.height / 2;
	await locator.page().mouse.move(startX, startY);
	await locator.page().mouse.down();
	await locator.page().mouse.move(startX + deltaX, startY + deltaY, { steps: 10 });
	await locator.page().mouse.up();
}
