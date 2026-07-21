import type { Page } from '@playwright/test';
import { pressArrow, pressEnter, pressEscape } from './keyboard.helpers.ts';

export async function navigateToMenuItem(page: Page, index: number): Promise<void> {
	await pressArrow(page, 'ArrowRight', index);
	await pressEnter(page);
	await page.waitForTimeout(200);
}

export async function goBack(page: Page): Promise<void> {
	await pressEscape(page);
	await page.waitForTimeout(200);
}

export async function getBreadcrumbText(page: Page): Promise<string> {
	const breadcrumb = page.locator('.breadcrumb');
	return (await breadcrumb.textContent()) ?? '';
}

export async function getMenuItemLabels(page: Page): Promise<string[]> {
	const items = page.locator('.menu-item .label');
	return items.allTextContents();
}

export async function waitForMenuVisible(page: Page): Promise<void> {
	await page.waitForSelector('.menu-item', { timeout: 10_000 });
}
