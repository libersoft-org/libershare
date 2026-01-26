/**
 * LISH (LiberShare Hash) data format handling
 */

export interface LISH {
	version: number;
	name: string;
	// TODO: Add more fields as needed (size, hash, files, etc.)
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
export function getLISHErrorMessage(
	errorCode: ParseLISHResult['error'],
	t: { downloads?: { errorInvalidFormat?: string; errorNoValidLish?: string } }
): string {
	switch (errorCode) {
		case 'INVALID_FORMAT':
		case 'INVALID_JSON':
			return t.downloads?.errorInvalidFormat || 'Invalid format';
		case 'NO_VALID_LISH':
			return t.downloads?.errorNoValidLish || 'No valid LISH found';
		default:
			return '';
	}
}
