import { brotliCompressSync, brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync, zstdDecompressSync, type ZlibOptions, constants as zlibConstants } from 'node:zlib';
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

/**
 * Everything {@link Utils.decompress} can read. `deflate` is decode-only: it arrives
 * as an HTTP `Content-Encoding`, but nothing here ever writes it, so it stays out of
 * {@link CompressionAlgorithm} and out of the file extensions and the UI selector.
 */
type DecompressAlgorithm = CompressionAlgorithm | 'deflate';

/** Compression algorithm each HTTP `Content-Encoding` token names. */
const CONTENT_ENCODING_ALGORITHMS: Record<string, DecompressAlgorithm> = { gzip: 'gzip', br: 'brotli', zstd: 'zstd', deflate: 'deflate' };

/**
 * Whether `data` opens with an RFC 1950 zlib header: the low nibble of the first byte is
 * the compression method, which must be 8 (deflate), and the two header bytes read as a
 * big-endian 16-bit value must be a multiple of 31.
 */
function hasZlibHeader(data: Uint8Array<ArrayBuffer>): boolean {
	return data.byteLength >= 2 && (data[0]! & 0x0f) === 8 && ((data[0]! << 8) | data[1]!) % 31 === 0;
}

/**
 * Inflate an HTTP `deflate` body. The name covers two wire formats: RFC 9110 asks for
 * the zlib wrapper (RFC 1950) and most servers send it, while a long tail sends bare
 * DEFLATE (RFC 1951). Only the leading bytes tell them apart, so the header check above
 * picks the decoder. Deciding that from the bytes rather than from a failed decode is what
 * keeps a broken zlib stream broken: the errors do not separate the two cases — a rejected
 * header and a corrupt body are both `Z_DATA_ERROR` — so retrying raw after any failure
 * reinterprets a truncated or tampered zlib body from byte zero.
 *
 * A body can also be complete and valid under *both* readings at once, and then each one
 * decodes to different content with no error on either side. Nothing settles which the
 * sender meant: RFC 9110 names the zlib wrapper, but Bun's own native `fetch` decoder reads
 * such a body as raw, so the spec and the runtime we sit on disagree, and either pick hands
 * the caller content nobody sent. Refusing is the only answer that cannot do that.
 *
 * A body without the zlib header is decoded once — node's inflate rejects every header this
 * check rejects, so the zlib reading cannot exist and there is nothing to be ambiguous with.
 * Only a zlib-headered body pays for a second decode, and on a real zlib body that decode
 * normally stops at the first stored-block length field, well under a millisecond. The bound
 * when it does not is `maxOutputLength`, which both decodes carry: the worst an ambiguity
 * check can add is one more capped inflate.
 *
 * Overrunning that cap is a raw reading that exists and is large, not one that is absent, so
 * it cannot license returning the zlib content: only a decoder verdict — a `Z_*` code — says
 * these bytes are not a raw stream at all. When the *zlib* reading is the oversized one, that
 * decode throws before the check is reached and the cap error stands: it is accurate whatever
 * the raw reading would have said, and it costs no second decode.
 */
function inflateDeflate(data: Uint8Array<ArrayBuffer>, options: ZlibOptions): Buffer {
	if (!hasZlibHeader(data)) return inflateRawSync(data, options);
	const inflated = inflateSync(data, options);
	try {
		inflateRawSync(data, options);
	} catch (err: any) {
		if (typeof err?.code === 'string' && err.code.startsWith('Z_')) return inflated;
	}
	throw new CodedError(ErrorCodes.AMBIGUOUS_DEFLATE);
}

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
	 * Every algorithm goes through node:zlib because Bun's own
	 * `gunzipSync` / `zstdDecompressSync` accept no options.
	 */
	static decompress(data: Uint8Array<ArrayBuffer>, algorithm: DecompressAlgorithm = 'gzip'): Uint8Array<ArrayBuffer> {
		const options = { maxOutputLength: MAX_API_MESSAGE_SIZE };
		try {
			switch (algorithm) {
				case 'gzip':
					return asBytes(gunzipSync(data, options));
				case 'brotli':
					return asBytes(brotliDecompressSync(data, options));
				case 'zstd':
					return asBytes(zstdDecompressSync(data, options));
				case 'deflate':
					return asBytes(inflateDeflate(data, options));
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
	private static contentEncodingAlgorithm(header: string | null): DecompressAlgorithm | null {
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
			// runs on the arriving chunk runs too late. It also drops `Accept-Encoding` from the
			// request, which asks for nothing rather than for plain bytes: with the field absent
			// every content coding is acceptable (RFC 9110), so an encoded body is exactly what a
			// compliant server is allowed to send back, and undoing it below is ours to do.
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
