import { type CompressionAlgorithm, isCompressed, CodedError, ErrorCodes } from '@shared';

export class Utils {
	static expandHome(path: string): string {
		// expand ~ to home directory
		if (path.startsWith('~')) {
			const home = process.env['HOME'] || process.env['USERPROFILE'];
			if (home) return home + path.slice(1);
		}
		return path;
	}

	/**
	 * Parse JSON with a descriptive error message on failure.
	 * Use this for user-provided or external data where the source is helpful for debugging.
	 */
	static safeJSONParse<T = unknown>(text: string, source: string): T {
		try {
			return JSON.parse(text);
		} catch (err: any) {
			throw new CodedError(ErrorCodes.INVALID_JSON, `${source}: ${err.message}`);
		}
	}

	/**
	 * Validate that all required parameters are present.
	 * Throws a descriptive error if any are missing (undefined).
	 */
	static assertParams<K extends string>(params: Record<string, any>, required: K[]): void {
		for (const key of required) {
			if (params[key] === undefined) throw new CodedError(ErrorCodes.MISSING_PARAMETER, key);
		}
	}

	/**
	 * Compress data using the specified algorithm.
	 * Single unified compression point for the entire project.
	 */
	static compress(data: Uint8Array<ArrayBuffer>, algorithm: CompressionAlgorithm = 'gzip'): Uint8Array<ArrayBuffer> {
		switch (algorithm) {
			case 'gzip':
				return Bun.gzipSync(data);
			default:
				throw new CodedError(ErrorCodes.UNSUPPORTED_COMPRESSION, algorithm);
		}
	}

	/**
	 * Decompress data using the specified algorithm.
	 * Single unified decompression point for the entire project.
	 */
	static decompress(data: Uint8Array<ArrayBuffer>, algorithm: CompressionAlgorithm = 'gzip'): Uint8Array<ArrayBuffer> {
		switch (algorithm) {
			case 'gzip':
				return Bun.gunzipSync(data);
			default:
				throw new CodedError(ErrorCodes.UNSUPPORTED_DECOMPRESSION, algorithm);
		}
	}

	/**
	 * Read a file, automatically decompressing compressed files.
	 * Returns the file content as a string.
	 */
	static async readFileCompressed(filePath: string, algorithm: CompressionAlgorithm = 'gzip'): Promise<string> {
		if (isCompressed(filePath)) {
			const compressed = await Bun.file(filePath).arrayBuffer();
			const decompressed = Utils.decompress(new Uint8Array(compressed), algorithm);
			return new TextDecoder().decode(decompressed);
		}
		return Bun.file(filePath).text();
	}

	/**
	 * Fetch a URL and return the response body as a string.
	 * Automatically decompresses .gz URLs. Throws on non-OK responses.
	 */
	static async fetchURL(url: string, timeoutMs: number = 10000): Promise<string> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(url, { signal: controller.signal });
			if (!response.ok) throw new CodedError(ErrorCodes.HTTP_ERROR, String(response.status));
			const isCompressedURL = isCompressed(url);
			const contentEncoding = response.headers.get('content-encoding');
			const isGzipEncoded = contentEncoding?.toLowerCase().includes('gzip');
			if (isCompressedURL && !isGzipEncoded) {
				const compressed = await response.arrayBuffer();
				const decompressed = Utils.decompress(new Uint8Array(compressed));
				return new TextDecoder().decode(decompressed);
			}
			return response.text();
		} finally {
			clearTimeout(timeout);
		}
	}

	/**
	 * Write JSON data to a file, optionally minified and/or compressed.
	 */
	static async writeJSONToFile(data: unknown, filePath: string, minifyJSON: boolean = false, compress: boolean = false, compressionAlgorithm: CompressionAlgorithm = 'gzip'): Promise<void> {
		const jsonContent = minifyJSON ? JSON.stringify(data) : JSON.stringify(data, null, '\t');
		if (compress) await Bun.write(filePath, Utils.compress(Buffer.from(jsonContent, 'utf-8'), compressionAlgorithm));
		else await Bun.write(filePath, jsonContent);
	}
}
