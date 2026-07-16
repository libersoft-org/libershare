// Format bytes to human-readable size
export function formatSize(bytes?: number): string {
	if (bytes === undefined) return '—';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Normalize a path by ensuring it ends with a trailing separator
export function normalizePath(path: string): string {
	if (!path) return path;
	return path.endsWith('/') || path.endsWith('\\') ? path : path + '/';
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

// Format ISO date to localized date + time string
export function formatDateTime(isoDate?: string): string {
	if (!isoDate) return '—';
	return new Date(isoDate).toLocaleString();
}

// Format an elapsed duration in seconds as zero-padded hh:mm:ss
// @param seconds - Elapsed seconds (negative values clamp to 0)
export function formatDuration(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number): string => String(n).padStart(2, '0');
	return `${pad(h)}:${pad(m)}:${pad(s)}`;
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

// Shorten a peer ID keeping a head and tail slice, matching the bootstrap peer list format.
export function shortenPeerID(id: string | null | undefined, head = 14, tail = 6): string {
	if (!id) return '—';
	if (id.length <= head + tail + 2) return id;
	return `${id.slice(0, head)}…${id.slice(-tail)}`;
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
export function openExternalURL(url: string): void {
	window.open(url, '_blank');
}

// Minify JSON string by removing whitespace
export function minifyJSON(json: string): string {
	try {
		return JSON.stringify(JSON.parse(json));
	} catch {
		return json;
	}
}
