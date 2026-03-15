import type { Page } from '@playwright/test';

export async function pressArrow(page: Page, direction: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight', times = 1): Promise<void> {
	for (let i = 0; i < times; i++) {
		await page.keyboard.press(direction);
		await page.waitForTimeout(100);
	}
}

export async function pressEnter(page: Page): Promise<void> {
	await page.keyboard.press('Enter');
	await page.waitForTimeout(100);
}

export async function pressEscape(page: Page): Promise<void> {
	await page.keyboard.press('Escape');
	await page.waitForTimeout(100);
}

export async function pressKey(page: Page, key: string): Promise<void> {
	await page.keyboard.press(key);
	await page.waitForTimeout(100);
}
