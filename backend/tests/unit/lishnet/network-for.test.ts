import { expect, test } from 'bun:test';
import { Networks } from '../../../src/lishnet/lishnets.ts';

const publicNode = { lishScope: null };
const networkFor = (rows: Record<string, object>, id: string): unknown => Networks.prototype.networkFor.call({ overlayNodes: { network: () => undefined }, get: (n: string) => rows[n], getRunningNetwork: () => publicNode } as any, id);

/**
 * A peer's listing read in a protected lishnet, retried once the lishnet was deleted meanwhile: the unknown ID went to the
 * public node and the request out to the public network.
 */
test('a lishnet that is no longer here has no node, never the public one', () => {
	expect(networkFor({ pub: { networkID: 'pub' } }, 'pub')).toBe(publicNode);
	expect(() => networkFor({ prot: { networkID: 'prot', overlay: {} } }, 'prot')).toThrow(expect.objectContaining({ code: 'NETWORK_NOT_RUNNING' }));
	expect(() => networkFor({}, 'deleted')).toThrow(expect.objectContaining({ code: 'NETWORK_NOT_FOUND' }));
});
