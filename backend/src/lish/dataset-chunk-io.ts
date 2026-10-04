import type { DatasetFileHandle } from './safe-dataset-types.ts';

export async function readDatasetRange(file: DatasetFileHandle, offset: number, length: number): Promise<Uint8Array> {
	if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(offset + length)) throw Object.assign(new Error('Invalid dataset read range'), { code: 'EINVAL' });
	const buffer = new Uint8Array(length);
	let completed = 0;
	while (completed < length) {
		const count = await file.read(buffer.subarray(completed), offset + completed);
		if (!Number.isInteger(count) || count < 0 || count > length - completed) throw Object.assign(new Error('Invalid dataset read result'), { code: 'EIO' });
		if (!count) break;
		completed += count;
	}
	return buffer.subarray(0, completed);
}
