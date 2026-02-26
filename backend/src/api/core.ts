import { Utils } from '../utils.ts';
const assert = Utils.assertParams;
type EmitFn = (client: any, event: string, data: any) => void;
type GetPeerCountsFn = () => { networkID: string; count: number }[];

export function initCoreHandlers(getPeerCounts: GetPeerCountsFn, emit: EmitFn) {
	function subscribe(p: { events?: string[]; event?: string }, client: any) {
		const events = Array.isArray(p.events) ? p.events : [p.event];
		events.forEach((e: string) => client.data.subscribedEvents.add(e));
		if (client.data.subscribedEvents.has('peers:count')) {
			const counts = getPeerCounts();
			if (counts.length > 0) emit(client, 'peers:count', counts);
		}
		return true;
	}

	function unsubscribe(p: { events?: string[]; event?: string }, client: any) {
		const events = Array.isArray(p.events) ? p.events : [p.event];
		events.forEach((e: string) => client.data.subscribedEvents.delete(e));
		return true;
	}

	async function fetchUrl(p: { url: string }) {
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

	return { subscribe, unsubscribe, fetchUrl };
}
