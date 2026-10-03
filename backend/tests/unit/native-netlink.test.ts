import { describe, expect, test } from 'bun:test';
import fixture from './fixtures/native-netlink/arm64.json';
import { decodeNetlinkAddresses, decodeNetlinkLinks, decodeNetlinkRoutes } from '../../src/native/linux/netlink.ts';
import { decodeAttributes, decodeNetlinkDatagram, decodeNetlinkDump, encodeAttribute, formatNetlinkAddress } from '../../src/native/linux/netlink-wire.ts';
import { requestNetlink, type NetlinkTransport } from '../../src/native/linux/netlink-socket.ts';
import { decodeNl80211Link, decodeNl80211Scan } from '../../src/native/linux/nl80211.ts';

function captured(raw: string[]) {
	return decodeNetlinkDump(
		raw.map(value => Buffer.from(value, 'base64')),
		fixture.sequence
	);
}

// Synthetic builders are only used below the captured oracle tests.
function message(type: number, body: Buffer = Buffer.alloc(0), flags = 2, sequence = 99): Buffer {
	const data = Buffer.alloc(16 + body.length);
	data.writeUInt32LE(data.length);
	data.writeUInt16LE(type, 4);
	data.writeUInt16LE(flags, 6);
	data.writeUInt32LE(sequence, 8);
	body.copy(data, 16);
	return data;
}

function u32(value: number): Buffer {
	const result = Buffer.alloc(4);
	result.writeUInt32LE(value);
	return result;
}

describe('captured ARM64 netlink responses against ip -j', () => {
	test('addresses retain scope, prefix, lease flags and lifetimes', () => {
		const actual = decodeNetlinkAddresses(captured(fixture.getaddr.raw));
		const expected = fixture.getaddr.truth.flatMap(link => link.addr_info.map(address => ({ ...address, index: link.ifindex })));
		expect(actual).toHaveLength(expected.length);
		for (const truth of expected) {
			const entry = actual.find(value => value.index === truth.index && value.local === truth.local);
			expect(entry).toBeDefined();
			for (const key of ['family', 'local', 'prefixlen', 'scope', 'preferred_life_time', 'valid_life_time'] as const) expect(entry![key]).toBe(truth[key]);
			for (const key of ['dynamic', 'tentative', 'dadfailed', 'deprecated'] as const) expect(entry![key]).toBe((truth as Record<string, unknown>)[key] === true);
		}
	});
	test('IPv4 defaults exactly match the recorded routes', () => {
		const ifnames = new Map(Object.entries(fixture.ifnames).map(([index, name]) => [Number(index), name]));
		expect<unknown>(decodeNetlinkRoutes(captured(fixture.getroute4.raw), ifnames)).toEqual(fixture.getroute4.truth);
	});
	test('IPv6 multipath defaults preserve nexthops and omit top-level dev', () => {
		const ifnames = new Map(Object.entries(fixture.ifnames).map(([index, name]) => [Number(index), name]));
		const routes = decodeNetlinkRoutes(captured(fixture.getroute6.raw), ifnames);
		expect<unknown>(routes).toEqual(fixture.getroute6.truth);
		expect(routes.every(route => !('dev' in route) && route.nexthops?.length === 2)).toBe(true);
	});
});

describe('synthetic malformed kernel responses', () => {
	test('rejects truncated, zero-length, unaligned and out-of-bounds headers', () => {
		for (const length of [0, 15, 17, 1024]) {
			const data = message(20);
			data.writeUInt32LE(length);
			expect(() => decodeNetlinkDatagram(data, 99)).toThrow('length');
		}
		expect(() => decodeNetlinkDatagram(Buffer.alloc(15), 99)).toThrow('header');
	});
	test('rejects malformed attributes including missing padding', () => {
		for (const length of [0, 3, 5, 65535]) {
			const data = Buffer.alloc(4);
			data.writeUInt16LE(length);
			expect(() => decodeAttributes(data)).toThrow('length');
		}
		expect(() => decodeAttributes(Buffer.alloc(3))).toThrow('attribute');
	});
	test('rejects foreign sequence, interrupted dump and kernel errors', () => {
		expect(() => decodeNetlinkDatagram(message(20), 100)).toThrow('sequence');
		expect(() => decodeNetlinkDatagram(message(3, u32(0), 0x12), 99)).toThrow('interrupted');
		const error = Buffer.alloc(4);
		error.writeInt32LE(-1);
		expect(() => decodeNetlinkDatagram(message(2, error), 99)).toThrow('Netlink error -1');
		expect(() => decodeNetlinkDatagram(message(3, error), 99)).toThrow('Netlink error -1');
		expect(() => decodeNetlinkDatagram(message(4), 99)).toThrow('overrun');
		expect(() => decodeNetlinkDatagram(message(2), 99)).toThrow('result');
	});
	test('an ACK does not complete a dump and DONE must be last', () => {
		expect(() => decodeNetlinkDump([message(2, u32(0))], 99)).toThrow('Incomplete');
		expect(() => decodeNetlinkDump([message(3), message(20)], 99)).toThrow('after dump');
		expect(() => decodeNetlinkDatagram(Buffer.concat([message(3), message(20)]), 99)).toThrow('after dump');
	});
	test('rejects short fixed structs, address fields and multipath nexthops', () => {
		expect(() => decodeNetlinkAddresses([{ type: 20, flags: 2, body: Buffer.alloc(7) }])).toThrow('ifaddrmsg');
		expect(() => formatNetlinkAddress(Buffer.alloc(15), 10)).toThrow('address');
		const route = Buffer.alloc(12);
		route[0] = 2;
		route[4] = 254;
		route[7] = 1;
		for (const length of [0, 7, 12]) {
			const hop = Buffer.alloc(8);
			hop.writeUInt16LE(length);
			expect(() => decodeNetlinkRoutes([{ type: 24, flags: 2, body: Buffer.concat([route, encodeAttribute(9, hop)]) }], new Map())).toThrow('nexthop');
		}
	});
	test('IFA_FLAGS overrides byte flags for tentative, failed and dynamic addresses', () => {
		const body = Buffer.alloc(8);
		body[0] = 2;
		body[1] = 24;
		body[2] = 0x80;
		const [entry] = decodeNetlinkAddresses([{ type: 20, flags: 2, body: Buffer.concat([body, encodeAttribute(1, Buffer.from([192, 0, 2, 1])), encodeAttribute(8, u32(0x68))]) }]);
		expect(entry).toMatchObject({ tentative: true, dadfailed: true, deprecated: true, dynamic: true });
	});
	test('interface flags and nested link kind are decoded independently of operstate', () => {
		const body = Buffer.alloc(16);
		body.writeUInt16LE(1, 2);
		body.writeInt32LE(8, 4);
		body.writeUInt32LE(1 | 2 | 65536, 8);
		const [link] = decodeNetlinkLinks([{ type: 16, flags: 2, body: Buffer.concat([body, encodeAttribute(3, Buffer.from('eth0\0')), encodeAttribute(16, Buffer.from([6])), encodeAttribute(18 | 0x8000, encodeAttribute(1, Buffer.from('veth\0')))]) }]);
		expect(link).toEqual({ ifindex: 8, ifname: 'eth0', flags: ['UP', 'BROADCAST', 'LOWER_UP'], operstate: 'UP', link_type: 'ether', linkinfo: { info_kind: 'veth' } });
	});
	test('IPv6 formatting compresses the longest zero run and preserves ties', () => {
		expect(formatNetlinkAddress(Buffer.from('20010000000000010000000000000001', 'hex'), 10)).toBe('2001:0:0:1::1');
		expect(formatNetlinkAddress(Buffer.alloc(16), 10)).toBe('::');
	});
});

describe('synthetic nl80211 messages', () => {
	const interfaces = (type: number) => [{ type: 30, flags: 0, body: Buffer.concat([Buffer.alloc(4), encodeAttribute(5, u32(type)), encodeAttribute(52, Buffer.from('Demo'))]) }];
	const station = (mac: string, signal: number) => ({ type: 30, flags: 2, body: Buffer.concat([Buffer.alloc(4), encodeAttribute(6, Buffer.from(mac, 'hex')), encodeAttribute(21, encodeAttribute(7, Buffer.from([signal & 0xff])))]) });
	const scan = (mac = '020000000001', status = 1) => decodeNl80211Scan([{ type: 30, flags: 2, body: Buffer.concat([Buffer.alloc(4), encodeAttribute(47, Buffer.concat([encodeAttribute(1, Buffer.from(mac, 'hex')), encodeAttribute(6, Buffer.from([0, 4, 68, 101, 109, 111])), encodeAttribute(9, u32(status))]))]) }]);
	test('decodes SSID and signed station signal without NetworkManager', () => {
		expect(decodeNl80211Link(interfaces(2), scan(), [station('020000000001', -38)])).toEqual({ ssid: 'Demo', bssid: '02:00:00:00:00:01', signal: -38 });
		expect(decodeNl80211Link(interfaces(2), [], [])).toEqual({ ssid: null, bssid: null, signal: null });
	});
	test('AP and P2P GO modes never expose connected clients as the upstream AP', () => {
		for (const mode of [3, 9]) expect(decodeNl80211Link(interfaces(mode), scan(), [station('020000000001', -38)])).toEqual({ ssid: null, bssid: null, signal: null });
	});
	test('selects the associated AP independently of TDLS station dump ordering', () => {
		const ap = station('020000000001', -38);
		const tdls = station('020000000002', -70);
		const nearby = scan('020000000002', 0);
		for (const stations of [
			[tdls, ap],
			[ap, tdls],
		]) {
			expect(decodeNl80211Link(interfaces(2), [...nearby, ...scan()], stations)).toEqual({ ssid: 'Demo', bssid: '02:00:00:00:00:01', signal: -38 });
		}
	});
	test('requires one associated BSS and its matching station', () => {
		expect(() => decodeNl80211Link(interfaces(2), [...scan(), ...scan('020000000002')], [])).toThrow('Ambiguous wireless association');
		expect(() => decodeNl80211Link(interfaces(2), scan(), [station('020000000002', -70)])).toThrow('associated station');
		expect(decodeNl80211Link(interfaces(2), scan('020000000002', 0), [station('020000000002', -70)])).toEqual({ ssid: null, bssid: null, signal: null });
	});
	test('scan cache contains BSSID, frequency, dBm, association and raw security IEs', () => {
		const signal = Buffer.alloc(4);
		signal.writeInt32LE(-3850);
		const elements = Buffer.from([0, 4, 68, 101, 109, 111, 48, 2, 1, 0]);
		const bss = Buffer.concat([encodeAttribute(1, Buffer.from('020000000001', 'hex')), encodeAttribute(2, u32(2412)), encodeAttribute(6, elements), encodeAttribute(7, signal), encodeAttribute(9, u32(1))]);
		const result = decodeNl80211Scan([{ type: 30, flags: 2, body: Buffer.concat([Buffer.alloc(4), encodeAttribute(47, bss)]) }]);
		expect(result).toEqual([{ ssid: 'Demo', bssid: '02:00:00:00:00:01', signal: -38.5, frequency: 2412, status: 1, capability: null, informationElements: elements }]);
	});
	test('rejects truncated SSID information elements', () => {
		const bss = Buffer.concat([encodeAttribute(1, Buffer.alloc(6)), encodeAttribute(6, Buffer.from([0, 8, 65]))]);
		expect(() => decodeNl80211Scan([{ type: 30, flags: 2, body: Buffer.concat([Buffer.alloc(4), encodeAttribute(47, bss)]) }])).toThrow('information element length');
	});
});

describe('netlink transport lifecycle with synthetic responses', () => {
	test('timeout closes owned socket instead of returning an empty dump', async () => {
		let closed = false;
		const transport: NetlinkTransport = {
			send() {},
			receive: () => undefined,
			close() {
				closed = true;
			},
		};
		await expect(requestNetlink(0, 22, Buffer.alloc(8), true, { timeoutMs: 10 }, () => transport)).rejects.toThrow('timed out');
		expect(closed).toBe(true);
	});
	test('abort closes the fd before a further receive', async () => {
		const controller = new AbortController();
		let closed = false;
		const transport: NetlinkTransport = {
			send() {},
			receive() {
				if (closed) throw new Error('receive after close');
				return undefined;
			},
			close() {
				closed = true;
			},
		};
		const pending = requestNetlink(0, 22, Buffer.alloc(8), true, { signal: controller.signal }, () => transport);
		controller.abort();
		expect(closed).toBe(true);
		await expect(pending).rejects.toThrow();
	});
	test('correlates the reply sequence and does not return before DONE', async () => {
		let sequence = 0;
		let receives = 0;
		let closed = false;
		const transport: NetlinkTransport = {
			send(data) {
				sequence = data.readUInt32LE(8);
			},
			receive() {
				receives++;
				return receives === 1 ? message(20, Buffer.alloc(8), 2, sequence) : message(3, u32(0), 2, sequence);
			},
			close() {
				closed = true;
			},
		};
		const result = await requestNetlink(0, 22, Buffer.alloc(8), true, {}, () => transport);
		expect(result).toHaveLength(1);
		expect(receives).toBe(2);
		expect(closed).toBe(true);
	});
});
