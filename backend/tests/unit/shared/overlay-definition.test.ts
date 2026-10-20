import { describe, expect, it } from 'bun:test';
import { ipInSubnet, isHostPort, parseSubnet, subnetAddress, validateAccessRequest, validateOverlayDefinition } from '@shared';

const CA = '-----BEGIN NEBULA CERTIFICATE V2-----\nAAAA\n-----END NEBULA CERTIFICATE V2-----\n';
const PEER = '12D3KooWGzBgW1mHp7DpLbR2X5yfDN8dRtVYWNw2wXxu3yi1fYM5';
const definition = { type: 'nebula', caCert: CA, subnet: '100.64.0.0/16', lighthouses: [{ vpnIP: '100.64.0.1', addr: '203.0.113.7:4242', peerID: PEER }], relays: [{ vpnIP: '100.64.0.1', addr: 'relay.example.com:4242' }], lanDirect: false, version: 3 };

describe('subnet helpers', () => {
	it('parses aligned subnets only', () => {
		expect(parseSubnet('100.64.0.0/16')).toEqual({ base: 0x64400000, bits: 16, size: 65536 });
		expect(parseSubnet('100.64.0.1/16')).toBeNull();
		expect(parseSubnet('100.64.0.0/31')).toBeNull();
		expect(parseSubnet('100.64.0.0')).toBeNull();
		expect(parseSubnet('300.64.0.0/16')).toBeNull();
	});
	it('checks membership and numbers addresses', () => {
		expect(ipInSubnet('100.64.255.254', '100.64.0.0/16')).toBe(true);
		expect(ipInSubnet('100.65.0.1', '100.64.0.0/16')).toBe(false);
		expect(subnetAddress('100.64.0.0/16', 1)).toBe('100.64.0.1');
		expect(subnetAddress('100.64.0.0/16', 256)).toBe('100.64.1.0');
		expect(() => subnetAddress('100.64.0.0/30', 3)).toThrow();
	});
	it('accepts host:port for IPv4 and DNS names only', () => {
		expect(isHostPort('203.0.113.7:4242')).toBe(true);
		expect(isHostPort('relay.example.com:4242')).toBe(true);
		expect(isHostPort('203.0.113.7')).toBe(false);
		expect(isHostPort('203.0.113.7:0')).toBe(false);
		expect(isHostPort('bad host:1')).toBe(false);
	});
});

describe('validateOverlayDefinition', () => {
	it('returns a clean copy of a valid definition', () => {
		expect(validateOverlayDefinition({ ...definition, extra: 1 })).toEqual(definition as any);
	});
	it('defaults lanDirect and version', () => {
		const { lanDirect: _l, version: _v, ...rest } = definition;
		expect(validateOverlayDefinition(rest)).toMatchObject({ lanDirect: false, version: 0 });
	});
	it('refuses hosts outside the subnet, bad endpoints and foreign types', () => {
		expect(() => validateOverlayDefinition({ ...definition, relays: [{ vpnIP: '10.0.0.1', addr: '203.0.113.7:4242' }] })).toThrow('not in 100.64.0.0/16');
		expect(() => validateOverlayDefinition({ ...definition, lighthouses: [{ vpnIP: '100.64.0.1', addr: 'nope' }] })).toThrow('host:port');
		expect(() => validateOverlayDefinition({ ...definition, type: 'wireguard' })).toThrow('unsupported');
		expect(() => validateOverlayDefinition({ ...definition, caCert: 'x' })).toThrow('CA certificate');
		expect(() => validateOverlayDefinition({ ...definition, subnet: '100.64.0.1/16' })).toThrow('subnet');
	});
});

describe('validateAccessRequest', () => {
	const request = { type: 'lish-overlay-request', networkID: 'n1', name: ' Alice ', peerID: PEER, publicKey: '-----BEGIN NEBULA X25519 PUBLIC KEY-----\nAAAA\n-----END NEBULA X25519 PUBLIC KEY-----\n', created: '2026-10-16T08:00:00.000Z' };
	it('accepts a request and trims the name', () => {
		expect(validateAccessRequest(request).name).toBe('Alice');
		expect(validateAccessRequest({ ...request, infraAddr: '203.0.113.9:4242' }).infraAddr).toBe('203.0.113.9:4242');
	});
	it('refuses control characters, foreign keys and bad peer IDs', () => {
		expect(() => validateAccessRequest({ ...request, name: 'a\nb' })).toThrow('printable');
		expect(() => validateAccessRequest({ ...request, publicKey: '-----BEGIN NEBULA ED25519 PRIVATE KEY-----' })).toThrow('public key');
		expect(() => validateAccessRequest({ ...request, peerID: 'x' })).toThrow('peer ID');
		expect(() => validateAccessRequest({ ...request, infraAddr: 'x' })).toThrow('host:port');
	});
});
