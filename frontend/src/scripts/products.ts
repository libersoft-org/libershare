// Calculate number of columns in a grid by comparing Y positions of items. Useful for keyboard navigation in grid layouts.
export function getGridColumnsCount(itemElements: HTMLElement[]): number {
	if (itemElements.length < 2) return 1;
	const firstItemY = itemElements[0]!.offsetTop;
	let cols = 1;
	for (let i = 1; i < itemElements.length; i++) {
		if (itemElements[i]!.offsetTop === firstItemY) cols++;
		else break;
	}
	return cols;
}
