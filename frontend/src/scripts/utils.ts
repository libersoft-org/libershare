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
