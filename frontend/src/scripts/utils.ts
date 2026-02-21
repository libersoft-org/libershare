// Format bytes to human-readable size
export function formatSize(bytes?: number): string {
	if (bytes === undefined) return '—';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Normalize a path by ensuring it ends with a trailing separator
export function normalizePath(path: string): string {
	if (!path) return path;
	if (path.endsWith('/') || path.endsWith('\\')) return path;
	const sep = path.includes('\\') ? '\\' : '/';
	return path + sep;
}

// Sanitize filename - remove invalid characters and normalize spaces
export function sanitizeFilename(filename: string): string {
	// Remove characters not allowed in filenames: < > : " / \ | ? *
	// Then replace multiple spaces with single space
	return filename
		.replace(/[<>:"/\\|?*]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

// Join path segments
export function joinPath(...segments: string[]): string {
	return segments.filter(Boolean).join('/').replace(/\/+/g, '/');
}

// Format ISO date to localized date string
export function formatDate(isoDate?: string): string {
	if (!isoDate) return '—';
	return new Date(isoDate).toLocaleDateString();
}

// Format current time with localization options
// @param hour12 - Use 12-hour format (true) or 24-hour format (false)
// @param showSeconds - Include seconds in the output
export function formatTime(hour12: boolean, showSeconds: boolean): string {
	const now = new Date();
	const options: Intl.DateTimeFormatOptions = {
		hour: 'numeric',
		minute: 'numeric',
		hour12,
	};
	if (showSeconds) options.second = 'numeric';
	return now.toLocaleTimeString([], options);
}

// Truncate a long ID string with ellipsis in the middle
export function truncateID(id: string, maxLength = 16): string {
	if (id.length <= maxLength) return id;
	return `${id.slice(0, 6)}...${id.slice(-6)}`;
}

// Scroll an element into view with smooth animation.
// @param elements - Array of elements to scroll within
// @param index - Index of the element to scroll to
// @param instant - Use instant scroll instead of smooth animation
export function scrollToElement(elements: (HTMLElement | undefined)[], index: number, instant = false): void {
	const element = elements[index];
	if (element) {
		element.scrollIntoView({
			behavior: instant ? 'instant' : 'smooth',
			block: 'center',
		});
	}
}

// Open an external URL in a new browser tab/window
export function openExternalUrl(url: string): void {
	window.open(url, '_blank');
}

// Minify JSON string by removing whitespace
export function minifyJson(json: string): string {
	try {
		return JSON.stringify(JSON.parse(json));
	} catch {
		return json;
	}
}
