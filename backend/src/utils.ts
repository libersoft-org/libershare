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

/** Compression algorithm each HTTP `Content-Encoding` token names. */
const CONTENT_ENCODING_ALGORITHMS: Record<string, CompressionAlgorithm> = { gzip: 'gzip', br: 'brotli', zstd: 'zstd' };

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
	 * Read a response body into memory, giving up as soon as more than `limit`
	 * bytes have arrived.
	 *
	 * Neither `Content-Length` nor any other header can be trusted to say how much
	 * a remote server is about to send: it can lie, or send a chunked body with no
	 * length at all. Counting the bytes as they stream is the only cap that holds;
	 * checking a body that is already in memory is not a cap. The caller must have
	 * disabled automatic decompression, or these are post-expansion bytes counted
	 * after the allocation they were supposed to prevent.
	 */
	private static async readBodyCapped(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
		if (!response.body) return new Uint8Array(0);
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				// Check before keeping the chunk, so the retained bytes never pass the limit.
				if (total + value.byteLength > limit) throw new CodedError(ErrorCodes.RESPONSE_TOO_LARGE, formatBytes(limit));
				chunks.push(value);
				total += value.byteLength;
			}
		} finally {
			// Releases the connection whether we finished, gave up, or were aborted.
			await reader.cancel().catch(() => {});
		}
		const body = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return body;
	}

	/**
	 * Compression algorithm named by an HTTP `Content-Encoding` header, or null when the
	 * header is absent, empty or `identity`.
	 *
	 * Throws for any other value, including a multi-codec list. With automatic
	 * decompression off we are the only decoder in the path, so a codec we cannot read
	 * has to be an error — decoding it as text would hand the caller binary garbage.
	 */
	private static contentEncodingAlgorithm(header: string | null): CompressionAlgorithm | null {
		const token = header?.trim().toLowerCase() ?? '';
		if (token === '' || token === 'identity') return null;
		const algorithm = CONTENT_ENCODING_ALGORITHMS[token];
		if (!algorithm) throw new CodedError(ErrorCodes.UNSUPPORTED_DECOMPRESSION, token);
		return algorithm;
	}

	/**
	 * Fetch a URL and return the response body as a string.
	 * Automatically decompresses compressed URLs (.gz, .br, .zst, …). Throws on non-OK responses.
	 * Every expansion on the way is capped at {@link MAX_API_MESSAGE_SIZE}, as are the
	 * compressed bytes themselves while they arrive.
	 */
	static async fetchURL(url: string, timeoutMs: number = 10000): Promise<string> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			// `decompress: false` keeps Bun from undoing Content-Encoding inside its native
			// HTTP layer, where no check we write can reach: a few kilobytes of zstd expand to
			// hundreds of megabytes there before the first byte is handed to JS, so a cap that
			// runs on the arriving chunk runs too late. It also drops `Accept-Encoding` from
			// the request, so a well-behaved server sends nothing to undo in the first place.
			const response = await fetch(url, { signal: controller.signal, decompress: false });
			if (!response.ok) throw new CodedError(ErrorCodes.HTTP_ERROR, String(response.status));
			// Detect on the final URL's path first — a redirect can change the extension, and a
			// query string or fragment would hide it. Fall back to the requested URL, because a
			// CDN or release redirect often lands on an opaque blob path that carries no extension.
			const algorithm = detectCompression(Utils.urlPath(response.url || url)) ?? detectCompression(Utils.urlPath(url));
			const transport = Utils.contentEncodingAlgorithm(response.headers.get('content-encoding'));
			let body = await Utils.readBodyCapped(response, MAX_API_MESSAGE_SIZE);
			if (transport) body = Utils.decompress(body, transport);
			// A `.gz` served as `Content-Encoding: gzip` is one layer labelled twice, not two:
			// the extension still means something only when it names a different codec.
			if (algorithm && algorithm !== transport) body = Utils.decompress(body, algorithm);
			return new TextDecoder().decode(body);
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
