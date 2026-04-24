import { describe, it, expect } from 'bun:test';
import { ipToUint32, netmaskToCidrBits, ipInCIDR, isLoopback, isPrivate, isPublic, shouldDenyDial, extractFirstIPv4 } from '../../../src/protocol/address-filter.ts';

describe('ipToUint32', () => {
	it('parses dotted quad', () => {
		expect(ipToUint32('0.0.0.0')).toBe(0);
		expect(ipToUint32('192.168.0.1')).toBe(0xc0a80001);
		expect(ipToUint32('255.255.255.255')).toBe(0xffffffff);
	});
	it('returns 0 for malformed', () => {
		expect(ipToUint32('not.an.ip.addr')).toBe(0);
		expect(ipToUint32('1.2.3')).toBe(0);
		expect(ipToUint32('256.0.0.0')).toBe(0);
	});
});

describe('netmaskToCidrBits', () => {
	it('converts common masks', () => {
		expect(netmaskToCidrBits('255.255.255.0')).toBe(24);
		expect(netmaskToCidrBits('255.255.0.0')).toBe(16);
		expect(netmaskToCidrBits('255.0.0.0')).toBe(8);
		expect(netmaskToCidrBits('255.255.254.0')).toBe(23);
		expect(netmaskToCidrBits('255.255.255.255')).toBe(32);
		expect(netmaskToCidrBits('0.0.0.0')).toBe(0);
	});
});

describe('ipInCIDR', () => {
	it('matches single host /32', () => {
		expect(ipInCIDR('10.0.0.1', '10.0.0.1/32')).toBe(true);
		expect(ipInCIDR('10.0.0.2', '10.0.0.1/32')).toBe(false);
	});
	it('matches /24', () => {
		expect(ipInCIDR('192.168.99.28', '192.168.99.0/24')).toBe(true);
		expect(ipInCIDR('192.168.99.255', '192.168.99.0/24')).toBe(true);
		expect(ipInCIDR('192.168.100.1', '192.168.99.0/24')).toBe(false);
	});
	it('matches /16', () => {
		expect(ipInCIDR('192.168.99.1', '192.168.0.0/16')).toBe(true);
		expect(ipInCIDR('192.169.0.1', '192.168.0.0/16')).toBe(false);
	});
	it('matches /23 (spans two /24s)', () => {
		expect(ipInCIDR('192.168.98.1', '192.168.98.0/23')).toBe(true);
		expect(ipInCIDR('192.168.99.1', '192.168.98.0/23')).toBe(true);
		expect(ipInCIDR('192.168.100.1', '192.168.98.0/23')).toBe(false);
	});
	it('accepts host-address form (CIDR with host bits set)', () => {
		// PVE adds the CIDR as "192.168.99.22/23" where 22 is host within the /23 net.
		expect(ipInCIDR('192.168.99.28', '192.168.99.22/23')).toBe(true);
	});
	it('handles /0 (everything)', () => {
		expect(ipInCIDR('8.8.8.8', '0.0.0.0/0')).toBe(true);
	});
	it('rejects invalid CIDR', () => {
		expect(ipInCIDR('1.2.3.4', '1.2.3.4/33')).toBe(false);
		expect(ipInCIDR('1.2.3.4', '1.2.3.4/-1')).toBe(false);
	});
});

describe('isLoopback', () => {
	it('covers 127.0.0.0/8', () => {
		expect(isLoopback('127.0.0.1')).toBe(true);
		expect(isLoopback('127.99.99.99')).toBe(true);
		expect(isLoopback('126.255.255.255')).toBe(false);
		expect(isLoopback('128.0.0.0')).toBe(false);
	});
});

describe('isPrivate', () => {
	it('covers RFC1918', () => {
		expect(isPrivate('10.0.0.1')).toBe(true);
		expect(isPrivate('10.255.255.255')).toBe(true);
		expect(isPrivate('172.16.0.1')).toBe(true);
		expect(isPrivate('172.31.255.255')).toBe(true);
		expect(isPrivate('172.32.0.1')).toBe(false);
		expect(isPrivate('192.168.0.1')).toBe(true);
		expect(isPrivate('192.168.255.255')).toBe(true);
	});
	it('covers link-local 169.254/16', () => {
		expect(isPrivate('169.254.0.1')).toBe(true);
		expect(isPrivate('169.254.255.255')).toBe(true);
		expect(isPrivate('169.255.0.0')).toBe(false);
	});
	it('covers CGNAT 100.64/10', () => {
		expect(isPrivate('100.64.0.1')).toBe(true);
		expect(isPrivate('100.127.255.255')).toBe(true);
		expect(isPrivate('100.128.0.0')).toBe(false);
		expect(isPrivate('100.63.255.255')).toBe(false);
	});
	it('returns false for public', () => {
		expect(isPrivate('8.8.8.8')).toBe(false);
		expect(isPrivate('203.0.113.10')).toBe(false);
	});
});

describe('isPublic', () => {
	it('accepts globally routable IPv4', () => {
		expect(isPublic('8.8.8.8')).toBe(true);
		expect(isPublic('1.1.1.1')).toBe(true);
		expect(isPublic('203.0.113.10')).toBe(true);
		expect(isPublic('198.51.100.1')).toBe(true);
		expect(isPublic('203.0.113.20')).toBe(true);
	});
	it('rejects private / loopback / multicast / zero', () => {
		expect(isPublic('192.168.99.28')).toBe(false);
		expect(isPublic('<redacted-vpn-ip>')).toBe(false);
		expect(isPublic('127.0.0.1')).toBe(false);
		expect(isPublic('0.0.0.0')).toBe(false);
		expect(isPublic('224.0.0.1')).toBe(false); // multicast
		expect(isPublic('100.64.5.5')).toBe(false); // CGNAT
	});
});

describe('extractFirstIPv4', () => {
	it('extracts from getComponents() code 4 entries', () => {
		const ma = {
			getComponents: () => [
				{ code: 4, value: '203.0.113.10' },
				{ code: 6, value: 9090 },
			],
		};
		expect(extractFirstIPv4(ma)).toBe('203.0.113.10');
	});
	it('returns null if no IPv4 component (DNS multiaddr)', () => {
		const ma = {
			getComponents: () => [
				{ code: 54, value: 'bootstrap.example.test' },
				{ code: 6, value: 9090 },
			],
		};
		expect(extractFirstIPv4(ma)).toBe(null);
	});
	it('returns null on missing getComponents', () => {
		expect(extractFirstIPv4({})).toBe(null);
		expect(extractFirstIPv4(null)).toBe(null);
	});
	it('falls back to nodeAddress()', () => {
		const ma = { nodeAddress: () => ({ family: 4, address: '192.168.99.11', port: 9090 }) };
		expect(extractFirstIPv4(ma)).toBe('192.168.99.11');
	});
});

// ---------------------------------------------------------------------------
// shouldDenyDial — primary decision function
// ---------------------------------------------------------------------------

function mkMA(ip: string | null): any {
	return ip === null
		? { getComponents: () => [{ code: 54, value: 'some.dns.name' }] }
		: { getComponents: () => [{ code: 4, value: ip }, { code: 6, value: 9090 }] };
}

describe('shouldDenyDial', () => {
	const lanOnly = ['192.168.99.22/23']; // node lives on a private /23 LAN only
	const publicOnly = ['203.0.113.10/32']; // node has only a single public IP
	const mixed = ['203.0.113.10/32', '<redacted-lan-ip>/23', '<redacted-vpn-ip>/24'];

	it('allows any multiaddr without IPv4 (DNS, circuit-relay)', () => {
		expect(shouldDenyDial(mkMA(null), publicOnly)).toBe(false);
	});

	it('denies loopback addresses (127.x) for remote peers', () => {
		expect(shouldDenyDial(mkMA('127.0.0.1'), lanOnly)).toBe(true);
		expect(shouldDenyDial(mkMA('127.0.0.1'), publicOnly)).toBe(true);
	});

	it('allows any public IPv4 regardless of local interfaces', () => {
		expect(shouldDenyDial(mkMA('203.0.113.10'), lanOnly)).toBe(false);
		expect(shouldDenyDial(mkMA('8.8.8.8'), publicOnly)).toBe(false);
		expect(shouldDenyDial(mkMA('203.0.113.20'), [])).toBe(false);
	});

	it('denies LAN multiaddr when the node has only a public interface', () => {
		// A public-only node has no LAN interface → deny any private-range multiaddr.
		expect(shouldDenyDial(mkMA('192.168.99.28'), publicOnly)).toBe(true);
		expect(shouldDenyDial(mkMA('10.0.0.5'), publicOnly)).toBe(true);
	});

	it('allows LAN multiaddr when the node shares the same subnet', () => {
		// Both nodes on 192.168.99.0/23 — LAN peer is directly reachable.
		expect(shouldDenyDial(mkMA('192.168.99.28'), lanOnly)).toBe(false);
		expect(shouldDenyDial(mkMA('192.168.98.5'), lanOnly)).toBe(false); // also in /23
	});

	it('denies LAN multiaddr from DIFFERENT private subnet even if I have LAN interfaces', () => {
		// I have 192.168.22.x; peer has 192.168.99.28 → deny (different /23)
		expect(shouldDenyDial(mkMA('192.168.99.28'), ['<redacted-lan-ip>/23'])).toBe(true);
	});

	it('allows VPN LAN when I share the VPN subnet', () => {
		// Mixed: public + LAN 22.x + VPN 10.254.x. Peer on <redacted-vpn-ip> → allow.
		expect(shouldDenyDial(mkMA('<redacted-vpn-ip>'), mixed)).toBe(false);
	});

	it('denies CGNAT peers unless I share the CGNAT range', () => {
		expect(shouldDenyDial(mkMA('100.64.5.5'), publicOnly)).toBe(true);
		expect(shouldDenyDial(mkMA('100.64.5.5'), ['100.64.0.0/10'])).toBe(false);
	});
});
