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
		const finalPath = outputFilePath.endsWith('.gz') ? outputFilePath : outputFilePath + '.gz';
		await Bun.write(finalPath, compressed);
		console.log(`✓ LISH exported (gzip) to: ${finalPath}`);
	} else {
		await Bun.write(outputFilePath, jsonContent);
		console.log(`✓ LISH exported to: ${outputFilePath}`);
	}
}
