import { brotliCompressSync, brotliDecompressSync, gunzipSync, zstdDecompressSync, constants as zlibConstants } from 'node:zlib';
import { type CompressionAlgorithm, detectCompression, formatBytes, CodedError, ErrorCodes, MAX_API_MESSAGE_SIZE } from '@shared';

/**
 * Brotli encoder quality. The library default is 11 (maximum), which costs about
 * 100x the CPU of quality 5 for roughly 20% smaller output — and since every
 * compression call here is synchronous, that time is the whole backend frozen.
 * Quality only affects the encoder; any quality decodes with the same reader.
 */
const BROTLI_QUALITY = 5;

/** Re-view a Buffer / Uint8Array as a plain `Uint8Array<ArrayBuffer>` without copying. */
function asBytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
	return new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
}

/** HTTP `Content-Encoding` token that corresponds to each compression algorithm. */
const CONTENT_ENCODING_TOKENS: Record<CompressionAlgorithm, string> = { gzip: 'gzip', brotli: 'br', zstd: 'zstd' };

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
		for (const key of required) if (params[key] === undefined) throw new CodedError(ErrorCodes.MISSING_PARAMETER, key);
	}

	/**
	 * Compress data using the specified algorithm.
	 * Single unified compression point for the entire project.
	 */
	static compress(data: Uint8Array<ArrayBuffer>, algorithm: CompressionAlgorithm = 'gzip'): Uint8Array<ArrayBuffer> {
		switch (algorithm) {
			case 'gzip':
				return Bun.gzipSync(data);
			case 'brotli':
				return asBytes(brotliCompressSync(data, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: data.byteLength } }));
			case 'zstd':
				return asBytes(Bun.zstdCompressSync(data));
			default:
				throw new CodedError(ErrorCodes.UNSUPPORTED_COMPRESSION, algorithm);
		}
	}

	/**
	 * Decompress data using the specified algorithm.
	 * Single unified decompression point for the entire project.
	 *
	 * Output is capped at {@link MAX_API_MESSAGE_SIZE}: a small compressed file
	 * can expand to gigabytes, and every caller here decompresses synchronously,
	 * so an uncapped expansion is an out-of-memory kill rather than an error.
	 * All three algorithms go through node:zlib because Bun's own
	 * `gunzipSync` / `zstdDecompressSync` accept no options.
	 */
	static decompress(data: Uint8Array<ArrayBuffer>, algorithm: CompressionAlgorithm = 'gzip'): Uint8Array<ArrayBuffer> {
		const options = { maxOutputLength: MAX_API_MESSAGE_SIZE };
		try {
			switch (algorithm) {
				case 'gzip':
					return asBytes(gunzipSync(data, options));
				case 'brotli':
					return asBytes(brotliDecompressSync(data, options));
				case 'zstd':
					return asBytes(zstdDecompressSync(data, options));
				default:
					throw new CodedError(ErrorCodes.UNSUPPORTED_DECOMPRESSION, algorithm);
			}
		} catch (err: any) {
			if (err?.code === 'ERR_BUFFER_TOO_LARGE') throw new CodedError(ErrorCodes.DECOMPRESSED_TOO_LARGE, formatBytes(MAX_API_MESSAGE_SIZE));
			throw err;
		}
	}

	/**
	 * Read a file, automatically decompressing compressed files.
	 * Without an explicit `algorithm` the compression is detected from the file
	 * extension; a path with no known extension is read as plain text.
	 * Returns the file content as a string.
	 */
	static async readFileCompressed(filePath: string, algorithm?: CompressionAlgorithm): Promise<string> {
		const resolved = algorithm ?? detectCompression(filePath);
		if (resolved) {
			const compressed = await Bun.file(filePath).arrayBuffer();
			const decompressed = Utils.decompress(new Uint8Array(compressed), resolved);
			return new TextDecoder().decode(decompressed);
		}
		return Bun.file(filePath).text();
	}

	/**
	 * Path component of an http(s) URL, without query string or fragment.
	 * Anything else — a local path in particular — is returned unchanged, because
	 * `new URL()` would read a Windows drive letter as a scheme and a `#` in a file
	 * name as a fragment.
	 */
	static urlPath(url: string): string {
		try {
			const parsed = new URL(url);
			return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.pathname : url;
		} catch {
			return url;
		}
	}

	/**
	 * Fetch a URL and return the response body as a string.
	 * Automatically decompresses compressed URLs (.gz, .br, .zst, …). Throws on non-OK responses.
	 */
	static async fetchURL(url: string, timeoutMs: number = 10000): Promise<string> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(url, { signal: controller.signal });
			if (!response.ok) throw new CodedError(ErrorCodes.HTTP_ERROR, String(response.status));
			// Detect on the final URL's path first — a redirect can change the extension, and a
			// query string or fragment would hide it. Fall back to the requested URL, because a
			// CDN or release redirect often lands on an opaque blob path that carries no extension.
			const algorithm = detectCompression(Utils.urlPath(response.url || url)) ?? detectCompression(Utils.urlPath(url));
			// When the server serves the file with the same codec as a transfer encoding,
			// fetch() has already undone it — decompressing a second time would fail.
			const contentEncoding = response.headers.get('content-encoding')?.toLowerCase() ?? '';
			const alreadyDecoded = algorithm !== null && contentEncoding.includes(CONTENT_ENCODING_TOKENS[algorithm]);
			if (algorithm && !alreadyDecoded) {
				const compressed = await response.arrayBuffer();
				const decompressed = Utils.decompress(new Uint8Array(compressed), algorithm);
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

	/**
	 * Find a directory path that does not yet exist by appending ` (N)` to the base name if needed.
	 * Used when importing a LISH to avoid clobbering an unrelated directory with the same name.
	 */
	static async findUniqueDirectory(baseDir: string): Promise<string> {
		const { access } = await import('fs/promises');
		try {
			await access(baseDir);
		} catch {
			return baseDir;
		}
		for (let i = 2; i < 1000; i++) {
			const candidate = `${baseDir} (${i})`;
			try {
				await access(candidate);
			} catch {
				return candidate;
			}
		}
		throw new CodedError(ErrorCodes.IO_NOT_FOUND, `too many existing directories for base: ${baseDir}`);
	}
}
