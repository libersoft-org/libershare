import { type FetchUrlResponse } from '@shared';
import { Utils } from '../utils.ts';
const assert = Utils.assertParams;

export function initCoreHandlers() {
	async function fetchUrl(p: { url: string }): Promise<FetchUrlResponse> {
		assert(p, ['url']);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);
		try {
			const response = await fetch(p.url, { signal: controller.signal });
			if (!response.ok) {
				return {
					url: p.url,
					status: response.status,
					contentType: response.headers.get('content-type'),
					content: '',
				};
			}
			const isGzipUrl = p.url.toLowerCase().endsWith('.gz');
			const contentEncoding = response.headers.get('content-encoding');
			const isGzipEncoded = contentEncoding?.toLowerCase().includes('gzip');
			let content: string;
			if (isGzipUrl && !isGzipEncoded) {
				const compressed = await response.arrayBuffer();
				const decompressed = Bun.gunzipSync(new Uint8Array(compressed));
				content = new TextDecoder().decode(decompressed);
			} else {
				content = await response.text();
			}
			try {
				JSON.parse(content);
			} catch {
				throw new Error('Response is not valid JSON');
			}
			return {
				url: p.url,
				status: response.status,
				contentType: response.headers.get('content-type'),
				content,
			};
		} finally {
			clearTimeout(timeout);
		}
	}

	return { fetchUrl };
}
