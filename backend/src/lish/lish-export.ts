import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { type IStoredLISH } from '@shared';

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
