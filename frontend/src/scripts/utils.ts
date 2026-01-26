/**
 * Format bytes to human-readable size
 */
export function formatSize(bytes?: number): string {
	if (bytes === undefined) return '—';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Format ISO date to localized date string
 */
export function formatDate(isoDate?: string): string {
	if (!isoDate) return '—';
	return new Date(isoDate).toLocaleDateString();
}

/**
 * Truncate a long ID string with ellipsis in the middle
 */
export function truncateID(id: string, maxLength = 16): string {
	if (id.length <= maxLength) return id;
	return `${id.slice(0, 6)}...${id.slice(-6)}`;
}

/**
 * Scroll an element into view with smooth animation.
 * @param elements - Array of elements to scroll within
 * @param index - Index of the element to scroll to
 * @param instant - Use instant scroll instead of smooth animation
 */
export function scrollToElement(elements: (HTMLElement | undefined)[], index: number, instant = false): void {
	const element = elements[index];
	if (element) {
		element.scrollIntoView({
			behavior: instant ? 'instant' : 'smooth',
			block: 'center',
		});
	}
}
