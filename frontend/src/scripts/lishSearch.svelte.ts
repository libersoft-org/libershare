import { type LishSearchResult } from '@shared';
import { api } from './api.ts';
import { translateError } from './language.ts';

/**
 * Reactive LISH search session.
 *
 * Owns the WebSocket subscription, search lifecycle (start / cancel / dispose) and
 * incremental aggregation of results coming from the backend. Exposed properties are
 * Svelte 5 `$state`-backed via getters so consumers can read them reactively.
 */
export interface LishSearchSession {
	query: string;
	readonly searching: boolean;
	readonly results: LishSearchResult[];
	readonly error: string;
	readonly searchID: string | null;
	start(): Promise<void>;
	cancel(): Promise<void>;
	clear(): void;
	dispose(): void;
}

export function createLishSearch(): LishSearchSession {
	let query = $state('');
	let searching = $state(false);
	let searchID = $state<string | null>(null);
	let error = $state('');
	let results = $state<LishSearchResult[]>([]);

	function handleUpdate(data: unknown): void {
		const d = data as { searchID: string; lishs: LishSearchResult[] };
		if (d.searchID !== searchID) return;
		// Backend sends the cumulative row for each updated LISH. Mutate existing row in
		// place when present (preserves object identity for any caller holding a snapshot
		// reference, e.g. detail page captured by openLishPeerList) and only insert a
		// fresh row when the LISH was not seen before. Without this, replacing the row
		// object orphaned the detail page's reference and `peers` updates stopped
		// propagating into the open detail view.
		const byID = new Map(results.map(r => [r.id, r] as const));
		let inserted = false;
		for (const incoming of d.lishs) {
			const existing = byID.get(incoming.id);
			if (existing) {
				// Merge: in-place replace fields the backend may have refined (name, totalSize)
				// and union the peers list by peerID.
				if (incoming.name !== undefined) existing.name = incoming.name;
				if (incoming.totalSize !== undefined) existing.totalSize = incoming.totalSize;
				const known = new Set(existing.peers.map(p => p.peerID));
				for (const p of incoming.peers) if (!known.has(p.peerID)) existing.peers.push(p);
			} else {
				byID.set(incoming.id, incoming);
				inserted = true;
			}
		}
		// Only reassign results array reference if a new LISH was discovered — Svelte 5
		// reactivity tracks deep mutations on existing rows automatically.
		if (inserted) results = [...byID.values()];
	}
	function handleComplete(data: unknown): void {
		const d = data as { searchID: string };
		if (d.searchID !== searchID) return;
		searching = false;
	}

	void api.subscribe('search:lishs:update', 'search:lishs:complete');
	const offUpdate = api.on('search:lishs:update', handleUpdate);
	const offComplete = api.on('search:lishs:complete', handleComplete);

	async function start(): Promise<void> {
		const trimmed = query.trim();
		if (trimmed.length === 0) return;
		// Cancel any previous in-flight search before starting a fresh one.
		if (searchID) {
			try {
				await api.search.cancelSearch(searchID);
			} catch {}
		}
		searching = true;
		error = '';
		results = [];
		try {
			const res = await api.search.startSearch(trimmed);
			searchID = res.searchID;
		} catch (e: any) {
			error = translateError(e);
			searching = false;
			searchID = null;
		}
	}

	async function cancel(): Promise<void> {
		if (!searchID) return;
		try {
			await api.search.cancelSearch(searchID);
		} catch {}
		// `search:lishs:complete` event will also flip searching to false; do it here in case it's missed.
		searching = false;
	}

	function clear(): void {
		results = [];
		error = '';
		searchID = null;
	}

	function dispose(): void {
		offUpdate?.();
		offComplete?.();
		void api.unsubscribe('search:lishs:update', 'search:lishs:complete');
		// Cancel any in-flight search on disposal.
		if (searchID) void api.search.cancelSearch(searchID).catch(() => {});
	}

	return {
		get query(): string {
			return query;
		},
		set query(v: string) {
			query = v;
		},
		get searching(): boolean {
			return searching;
		},
		get results(): LishSearchResult[] {
			return results;
		},
		get error(): string {
			return error;
		},
		get searchID(): string | null {
			return searchID;
		},
		start,
		cancel,
		clear,
		dispose,
	};
}
