import { describe, expect, it } from 'bun:test';
import { type LISHOverlayDefinition } from '@shared';
import { buildNebulaConfig, infraHosts, orderRelays } from '../../../src/overlay/nebula-config.ts';

const PEER = '12D3KooWGzBgW1mHp7DpLbR2X5yfDN8dRtVYWNw2wXxu3yi1fYM5';
const overlay: LISHOverlayDefinition = {
	type: 'nebula',
	caCert: '-----BEGIN NEBULA CERTIFICATE V2-----\nAAAA\n-----END NEBULA CERTIFICATE V2-----\n',
	subnet: '100.64.0.0/16',
	lighthouses: [
		{ vpnIP: '100.64.0.1', addr: '203.0.113.7:4242' },
		{ vpnIP: '100.64.0.2', addr: 'lh2.example.com:4243' },
	],
	relays: [
		{ vpnIP: '100.64.0.1', addr: '203.0.113.7:4242' },
		{ vpnIP: '100.64.0.3', addr: '198.51.100.9:4242' },
	],
	lanDirect: false,
	version: 0,
};
const pki = { ca: 'ca.crt', cert: 'member.crt', key: 'member.key' };
const member = (extra: Partial<LISHOverlayDefinition> = {}): any => buildNebulaConfig({ pki, overlay: { ...overlay, ...extra }, vpnIP: '100.64.0.20', peerID: PEER, revoked: ['ab'.repeat(32)], infraIPs: ['203.0.113.7', '192.0.2.44', '198.51.100.9'] });

describe('buildNebulaConfig — member', () => {
	it('talks to the infrastructure only, in both address families', () => {
		const lh = member().lighthouse;
		expect(lh.remote_allow_list).toEqual({ '0.0.0.0/0': false, '::/0': false, '203.0.113.7/32': true, '192.0.2.44/32': true, '198.51.100.9/32': true });
		expect(lh.local_allow_list).toEqual({ '0.0.0.0/0': false, '::/0': false });
		expect(member().punchy).toEqual({ punch: false, respond: false });
	});

	it('reports LAN addresses and allows LAN neighbours only with lanDirect', () => {
		const config = member({ lanDirect: true });
		expect(config.lighthouse.local_allow_list).toMatchObject({ '0.0.0.0/0': false, '10.0.0.0/8': true, '172.16.0.0/12': true, '192.168.0.0/16': true });
		expect(config.lighthouse.remote_allow_list['192.168.0.0/16']).toBe(true);
		expect(config.punchy).toEqual({ punch: true, respond: true });
	});

	it('finds the lighthouses, enforces revocations and accepts only the node port', () => {
		const config = member();
		expect(config.lighthouse.am_lighthouse).toBe(false);
		expect(config.lighthouse.hosts).toEqual(['100.64.0.1', '100.64.0.2']);
		expect(config.static_host_map).toEqual({ '100.64.0.1': ['203.0.113.7:4242'], '100.64.0.2': ['lh2.example.com:4243'], '100.64.0.3': ['198.51.100.9:4242'] });
		expect(config.pki).toEqual({ ...pki, blocklist: ['ab'.repeat(32)], disconnect_invalid: true });
		expect(config.listen).toEqual({ host: '0.0.0.0', port: 0, read_buffer: 32 * 1024 * 1024, write_buffer: 32 * 1024 * 1024 });
		expect(config.relay).toMatchObject({ am_relay: false, use_relays: true });
		expect([...config.relay.relays].sort()).toEqual(['100.64.0.1', '100.64.0.3']);
		expect(config.firewall.inbound).toEqual([{ port: 9090, proto: 'tcp', group: 'member' }]);
	});

	// An invite's guest certificate is signed by the same CA: a firewall open to any host let it reach every member.
	it('admits members only, and guests on a device holding the CA key', () => {
		const founder: any = buildNebulaConfig({ pki, overlay, vpnIP: '100.64.0.1', peerID: PEER, revoked: [], infraIPs: [], acceptGuests: true });
		expect(founder.firewall.inbound).toEqual([
			{ port: 9090, proto: 'tcp', group: 'member' },
			{ port: 9090, proto: 'tcp', group: 'guest' },
		]);
	});
});

describe('buildNebulaConfig — infrastructure', () => {
	it('a lighthouse and relay listens on its port, hides member addresses and filters nobody', () => {
		const config: any = buildNebulaConfig({ pki, overlay, vpnIP: '100.64.0.1', peerID: PEER, revoked: [], infraIPs: [] });
		expect(config.lighthouse).toEqual({ am_lighthouse: true, hosts: [], interval: 30, hide_addresses: true });
		expect(config.relay).toEqual({ am_relay: true, use_relays: true, relays: [] });
		expect(config.listen).toEqual({ host: '0.0.0.0', port: 4242, read_buffer: 32 * 1024 * 1024, write_buffer: 32 * 1024 * 1024 });
		expect(config.static_host_map['100.64.0.1']).toBeUndefined();
	});
});

describe('orderRelays', () => {
	it('is stable for one member and spreads members over the relays', () => {
		const relays = [1, 2, 3].map(i => ({ vpnIP: `100.64.0.${i}`, addr: `203.0.113.${i}:4242` }));
		expect(orderRelays(relays, PEER)).toEqual(orderRelays([...relays].reverse(), PEER));
		const firsts = new Set(Array.from({ length: 30 }, (_, i) => orderRelays(relays, `peer-${i}`)[0]));
		expect(firsts.size).toBe(3);
	});
});

describe('infraHosts', () => {
	it('lists each host name once', () => {
		expect(infraHosts(overlay).sort()).toEqual(['198.51.100.9', '203.0.113.7', 'lh2.example.com']);
	});
});
