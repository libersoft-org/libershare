import { CodedError, ErrorCodes, sanitizeFilename, type ILISH } from '@shared';

export function datasetRootName(lish: Pick<ILISH, 'name' | 'id'>): string {
	const name = sanitizeFilename(lish.name ?? lish.id);
	const device = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?: *\.|$)/i;
	if (!name || name === '.' || name === '..' || /[. ]$/.test(name) || device.test(name)) {
		throw new CodedError(ErrorCodes.LISH_UNSAFE_PATH, 'The dataset root must have a safe directory name');
	}
	return name;
}
