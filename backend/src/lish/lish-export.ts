import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { type ILISH, type IStoredLISH, SUPPORTED_ALGOS } from '@shared';
import { Utils } from '../utils.ts';

export async function exportLISHToFile(lish: IStoredLISH, outputFilePath: string, minifyJson: boolean = false, compressGzip: boolean = false): Promise<void> {
	const outputDir = dirname(outputFilePath);
	await mkdir(outputDir, { recursive: true });
	// Export without local-only fields
	const { directory, chunks, ...exportData } = lish;
	const jsonContent = minifyJson ? JSON.stringify(exportData) : JSON.stringify(exportData, null, 2);
	if (compressGzip) {
		const { gzipSync } = await import('zlib');
		const compressed = gzipSync(Buffer.from(jsonContent));
		await Bun.write(outputFilePath, compressed);
		console.log(`✓ LISH exported (gzip) to: ${outputFilePath}`);
	} else {
		await Bun.write(outputFilePath, jsonContent);
		console.log(`✓ LISH exported to: ${outputFilePath}`);
	}
}

/**
 * Validate that the given data is a valid ILISH object.
 * Throws a descriptive error if any required field is missing or invalid.
 */
export function validateImportedLISH(data: unknown): ILISH {
	if (!data || typeof data !== 'object') throw new Error('Invalid LISH: not an object');
	const obj = data as Record<string, unknown>;
	if (typeof obj['id'] !== 'string' || !obj['id']) throw new Error('Invalid LISH: missing or empty id');
	if (typeof obj['created'] !== 'string' || !obj['created']) throw new Error('Invalid LISH: missing or empty created');
	if (typeof obj['chunkSize'] !== 'number' || obj['chunkSize'] <= 0) throw new Error('Invalid LISH: missing or invalid chunkSize');
	if (typeof obj['checksumAlgo'] !== 'string' || !(SUPPORTED_ALGOS as readonly string[]).includes(obj['checksumAlgo'])) {
		throw new Error(`Invalid LISH: unsupported checksumAlgo: ${obj['checksumAlgo']}`);
	}
	return data as ILISH;
}

/**
 * Read a .lish or .lish.gz file and return the parsed ILISH.
 */
export async function importLISHFromFile(filePath: string): Promise<ILISH> {
	const isGzip = filePath.toLowerCase().endsWith('.gz');
	let content: string;
	if (isGzip) {
		const compressed = await Bun.file(filePath).arrayBuffer();
		const decompressed = Bun.gunzipSync(new Uint8Array(compressed));
		content = new TextDecoder().decode(decompressed);
	} else {
		content = await Bun.file(filePath).text();
	}
	const data = Utils.safeJSONParse(content, filePath);
	return validateImportedLISH(data);
}

/**
 * Parse a JSON string into a validated ILISH object.
 * Throws if the string is not valid JSON, is an array, or fails validation.
 */
export function parseLISHFromJson(json: string): ILISH {
	const data = Utils.safeJSONParse(json, 'JSON input');
	if (Array.isArray(data)) throw new Error('Expected a single LISH object, got an array');
	return validateImportedLISH(data);
}
