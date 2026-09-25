import type { BootstrapPeerStatus } from '@shared';

/**
 * What one peer identity's addresses add up to, for the bootstrap table. Not a network status:
 * a peer reachable on one address while another one fails is `partial`, so neither the working
 * address nor the broken configuration is hidden behind the other.
 */
export type BootstrapGroupSummary = 'healthy' | 'partial' | 'problem' | 'pending';

/** How many of a group's addresses work, fail or are still being tried. */
export interface BootstrapGroupCounts {
	connected: number;
	failing: number;
	pending: number;
}

/** The identity a status entry belongs to; a mismatched identity stays in the group it was expected in. */
export function bootstrapGroupKey(entry: BootstrapPeerStatus): string {
	return entry.expectedPeerID ?? entry.actualPeerID ?? entry.multiaddr;
}

/** Summarise every address of one identity. Pass the whole group, not a filtered view of it. */
export function summarizeBootstrapGroup(entries: readonly BootstrapPeerStatus[]): { summary: BootstrapGroupSummary; counts: BootstrapGroupCounts } {
	const counts: BootstrapGroupCounts = { connected: 0, failing: 0, pending: 0 };
	for (const entry of entries) {
		if (entry.status === 'connected') counts.connected++;
		else if (entry.status === 'pending') counts.pending++;
		else counts.failing++;
	}
	const summary: BootstrapGroupSummary = counts.connected > 0 ? (counts.failing === 0 && counts.pending === 0 ? 'healthy' : 'partial') : counts.failing > 0 ? 'problem' : 'pending';
	return { summary, counts };
}
