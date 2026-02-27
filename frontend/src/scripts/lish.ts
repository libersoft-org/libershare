// LISH (Hash) data format handling
export interface LISH {
	version: number;
	name: string;
	// TODO: Add more fields as needed (size, hash, files, etc.)
}

/**
 * Size unit multipliers (base 1024)
 */
const SIZE_UNITS: Record<string, number> = {
	B: 1,
	K: 1024,
	M: 1024 * 1024,
	G: 1024 * 1024 * 1024,
	T: 1024 * 1024 * 1024 * 1024,
};

/**
 * Parse chunk size string (e.g., "1M", "512K", "1G") to bytes.
 * Returns null if invalid.
 */
export function parseChunkSize(value: string): number | null {
	const trimmed = value.trim().toUpperCase();
	if (!trimmed) return null;

	// Just a number - treat as bytes
	const justNumber = parseInt(trimmed);
	if (!isNaN(justNumber) && trimmed === String(justNumber)) {
		return justNumber > 0 ? justNumber : null;
	}

	// Number with unit suffix
	const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([BKMGT])$/);
	if (!match) return null;

	const num = parseFloat(match[1]);
	const unit = match[2];
	const multiplier = SIZE_UNITS[unit];

	if (isNaN(num) || num <= 0 || !multiplier) return null;

	return Math.floor(num * multiplier);
}

/**
 * Format bytes to human-readable size string
 */
export function formatChunkSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}M`;
	if (bytes < 1024 * 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(0)}G`;
	return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(0)}T`;
}

/**
 * Validate and normalize a raw object into a LISH.
 * Returns null if validation fails.
 */
export function validateLISH(obj: unknown): LISH | null {
	if (!obj || typeof obj !== 'object') return null;
	const parsed = obj as Record<string, unknown>;
	// Validate required fields
	if (typeof parsed.name !== 'string' || !parsed.name.trim()) return null;
	return {
		version: (parsed.version as number) ?? 1,
		name: parsed.name.trim(),
	};
}

/**
 * Parse JSON string and extract valid LISH objects.
 * Handles both single LISH and array of LISH.
 */
export interface ParseLISHResult {
	items: LISH[];
	error: 'INVALID_JSON' | 'INVALID_FORMAT' | 'NO_VALID_LISH' | null;
}

export function parseLISHFromJson(json: string): ParseLISHResult {
	if (!json.trim()) {
		return { items: [], error: 'INVALID_FORMAT' };
	}
	try {
		const parsed = JSON.parse(json);
		const lishToImport: LISH[] = [];
		// Check if it's an array or a single LISH
		if (Array.isArray(parsed)) {
			for (const item of parsed) {
				const lish = validateLISH(item);
				if (lish) lishToImport.push(lish);
			}
		} else {
			const lish = validateLISH(parsed);
			if (lish) lishToImport.push(lish);
		}
		if (lishToImport.length === 0) {
			return { items: [], error: 'NO_VALID_LISH' };
		}
		return { items: lishToImport, error: null };
	} catch {
		return { items: [], error: 'INVALID_JSON' };
	}
}

/**
 * Get localized error message for LISH parsing errors.
 */
export function getLISHErrorMessage(errorCode: ParseLISHResult['error'], t: (key: string) => string): string {
	switch (errorCode) {
		case 'INVALID_FORMAT':
		case 'INVALID_JSON':
			return t('downloads.errorInvalidFormat');
		case 'NO_VALID_LISH':
			return t('downloads.errorNoValidLISH');
		default:
			return '';
	}
}

/**
 * Validate chunk size input
 * Returns error code or null if valid
 */
export function validateChunkSize(chunkSize: string): 'INVALID_CHUNK_SIZE' | null {
	if (!chunkSize.trim()) return null;
	const parsed = parseChunkSize(chunkSize);
	return parsed === null ? 'INVALID_CHUNK_SIZE' : null;
}

/**
 * Validate threads input
 * Returns error code or null if valid
 */
export function validateThreads(threads: string): 'INVALID_THREADS' | null {
	if (!threads.trim()) return null;
	const num = parseInt(threads);
	return isNaN(num) || num < 0 ? 'INVALID_THREADS' : null;
}

/**
 * Validate LISH create form
 */
export interface LISHCreateFormData {
	dataPath: string;
	saveToFile?: boolean;
	lishFile?: string;
	addToSharing?: boolean;
	chunkSize?: string;
	threads?: string;
}

export type LISHCreateError = 'INPUT_REQUIRED' | 'LISH_FILE_REQUIRED' | 'INVALID_CHUNK_SIZE' | 'INVALID_THREADS' | null;

export function validateLISHCreateForm(data: LISHCreateFormData): LISHCreateError {
	if (!data.dataPath.trim()) return 'INPUT_REQUIRED';
	if (data.saveToFile && !data.lishFile?.trim()) return 'LISH_FILE_REQUIRED';
	if (data.chunkSize) {
		const chunkError = validateChunkSize(data.chunkSize);
		if (chunkError) return chunkError;
	}
	if (data.threads) {
		const threadsError = validateThreads(data.threads);
		if (threadsError) return threadsError;
	}
	return null;
}

/**
 * Get localized error message for LISH create validation errors
 */
export function getLISHCreateErrorMessage(errorCode: LISHCreateError, t: (key: string) => string): string {
	switch (errorCode) {
		case 'INPUT_REQUIRED':
			return t('downloads.lishCreate.dataPathRequired');
		case 'LISH_FILE_REQUIRED':
			return t('downloads.lishCreate.lishFileRequired');
		case 'INVALID_CHUNK_SIZE':
			return t('downloads.lishCreate.invalidChunkSize');
		case 'INVALID_THREADS':
			return t('downloads.lishCreate.invalidThreads');
		default:
			return '';
	}
}
