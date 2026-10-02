import { describe, expect, it } from 'bun:test';
import { IncompleteProfileReadError, MAX_PROFILES_PER_READ, parseNmcliProfileBlocks, readNmcliProfileBlocks } from '../../src/system-network-linux-profiles.ts';
import { parseNmcliIPv4Profile } from '../../src/system-network-linux.ts';

/**
 * Batched NetworkManager profile reads. Block shapes are the ones NetworkManager 1.42 and 1.46
 * print for `nmcli -t -m multiline -e yes -f … connection show uuid A uuid B …`: 1.42 separates
 * blocks with a blank line, 1.46 does not, and a bridge port has no `ipv4.*` lines at all.
 */

const IPV4_AUTO = ['ipv4.method:auto', 'ipv4.never-default:no', 'ipv4.gateway:', 'ipv4.addresses:', 'ipv4.routes:', 'ipv4.route-table:0', 'ipv4.routing-rules:'];

function block(uuid: string, type: string, iface: string, options: { master?: string; slaveType?: string; ipv4?: string[] | null } = {}): string {
	const lines = [`connection.uuid:${uuid}`, `connection.type:${type}`, `connection.master:${options.master ?? ''}`, `connection.slave-type:${options.slaveType ?? ''}`, `connection.interface-name:${iface}`, 'connection.multi-connect:0'];
	return [...lines, ...(options.ipv4 === null ? [] : (options.ipv4 ?? IPV4_AUTO))].join('\n');
}

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const BRIDGE = uuid(1);
const ETH = uuid(2);

/** A Docker-like host: one editable ethernet, one bridge and `ports` veth ports without IPv4. */
function host(ports: number): { uuids: string[]; blocks: string[] } {
	const blocks = [block(ETH, '802-3-ethernet', 'eth0'), block(BRIDGE, 'bridge', 'br0', { ipv4: ['ipv4.method:manual', 'ipv4.never-default:no', 'ipv4.gateway:', 'ipv4.addresses:192.0.2.1/24', 'ipv4.routes:', 'ipv4.route-table:0', 'ipv4.routing-rules:'] })];
	const uuids = [ETH, BRIDGE];
	for (let i = 0; i < ports; i++) {
		uuids.push(uuid(100 + i));
		blocks.push(block(uuid(100 + i), '802-3-ethernet', `veth${i}`, { master: BRIDGE, slaveType: 'bridge', ipv4: null }));
	}
	return { uuids, blocks };
}

/** A fake nmcli that answers each batched call from `blocks` in the requested order. */
function fakeNmcli(all: Map<string, string>, separator = '\n\n'): { calls: string[][]; run: (args: string[]) => Promise<string> } {
	const calls: string[][] = [];
	return {
		calls,
		run: async args => {
			calls.push(args);
			const requested = args.filter((_, i) => args[i - 1] === 'uuid');
			return requested.map(id => all.get(id)!).join(separator) + '\n';
		},
	};
}

const signal = new AbortController().signal;

describe('batched profile reads', () => {
	it('reads 150 profiles with one process and keeps each profile usable by the parser', async () => {
		const { uuids, blocks } = host(148);
		const nmcli = fakeNmcli(new Map(uuids.map((id, i) => [id, blocks[i]!])));
		const read = await readNmcliProfileBlocks(uuids, { run: nmcli.run, signal });
		expect(nmcli.calls.length).toBe(1);
		expect(read.size).toBe(150);
		expect(parseNmcliIPv4Profile(read.get(ETH)!, 'eth0', 1)).toMatchObject({ method: 'auto', safe: true });
		expect(parseNmcliIPv4Profile(read.get(uuid(100))!, 'veth0', 1)).toMatchObject({ method: '', safe: false });
	});

	it('accepts NetworkManager 1.46 output without blank lines between blocks', async () => {
		const { uuids, blocks } = host(3);
		const nmcli = fakeNmcli(new Map(uuids.map((id, i) => [id, blocks[i]!])), '\n');
		expect((await readNmcliProfileBlocks(uuids, { run: nmcli.run, signal })).size).toBe(5);
	});

	it('splits large sets into bounded batches, one after another, and reads nothing for none', async () => {
		const { uuids, blocks } = host(MAX_PROFILES_PER_READ + 50);
		const nmcli = fakeNmcli(new Map(uuids.map((id, i) => [id, blocks[i]!])));
		expect((await readNmcliProfileBlocks(uuids, { run: nmcli.run, signal })).size).toBe(uuids.length);
		expect(nmcli.calls.map(args => args.filter(a => a === 'uuid').length)).toEqual([MAX_PROFILES_PER_READ, uuids.length - MAX_PROFILES_PER_READ]);
		const idle = fakeNmcli(new Map());
		expect((await readNmcliProfileBlocks([], { run: idle.run, signal })).size).toBe(0);
		expect(idle.calls).toEqual([]);
	});

	it('starts no further batch once aborted', async () => {
		const { uuids, blocks } = host(MAX_PROFILES_PER_READ + 10);
		const all = new Map(uuids.map((id, i) => [id, blocks[i]!]));
		const controller = new AbortController();
		const nmcli = fakeNmcli(all);
		const run = async (args: string[]): Promise<string> => {
			const out = await nmcli.run(args);
			controller.abort();
			return out;
		};
		await expect(readNmcliProfileBlocks(uuids, { run, signal: controller.signal })).rejects.toThrow();
		expect(nmcli.calls.length).toBe(1);
	});

	it('keeps an escaped colon inside a value', () => {
		const rules = 'ipv4.routing-rules:priority 5 from 192.0.2.0/24 table 7 iif eth0\\:1';
		const read = parseNmcliProfileBlocks(block(ETH, '802-3-ethernet', 'eth0', { ipv4: [...IPV4_AUTO.slice(0, 6), rules] }), [ETH]);
		expect(parseNmcliIPv4Profile(read.get(ETH)!, 'eth0', 1).safe).toBe(false);
	});
});

describe('an incomplete batch is never trusted', () => {
	const eth = block(ETH, '802-3-ethernet', 'eth0');
	const cases: Array<[string, string, string[]]> = [
		['a missing profile', eth, [ETH, BRIDGE]],
		['a profile listed twice', `${eth}\n\n${eth}`, [ETH]],
		['a profile nobody asked for', block(uuid(9), 'bridge', 'br9'), [ETH]],
		['a repeated field', `${eth}\nipv4.method:manual`, [ETH]],
		['a missing connection field', eth.replace('connection.multi-connect:0\n', ''), [ETH]],
		['an empty type', eth.replace('connection.type:802-3-ethernet', 'connection.type:'), [ETH]],
		['a partial IPv4 section', eth.replace('\nipv4.routing-rules:', ''), [ETH]],
		['no IPv4 on a profile that is not a port', block(ETH, '802-3-ethernet', 'eth0', { ipv4: null }), [ETH]],
		['no IPv4 on an OVS interface', block(ETH, 'ovs-interface', 'ovs0', { master: BRIDGE, slaveType: 'ovs-port', ipv4: null }), [ETH]],
		['no IPv4 on a VRF port', block(ETH, '802-3-ethernet', 'eth0', { master: BRIDGE, slaveType: 'vrf', ipv4: null }), [ETH]],
		['a port type without a controller', block(ETH, '802-3-ethernet', 'eth0', { slaveType: 'bridge', ipv4: null }), [ETH]],
	];
	it.each(cases)('rejects %s', (_name, text, requested) => {
		expect(() => parseNmcliProfileBlocks(text, requested)).toThrow(IncompleteProfileReadError);
	});

	it('accepts the profiles NetworkManager gives no IPv4', () => {
		for (const [type, slaveType] of [
			['wpan', ''],
			['6lowpan', ''],
			['802-3-ethernet', 'bond'],
			['802-3-ethernet', 'team'],
			['ovs-port', 'ovs-bridge'],
		] as const) {
			const text = block(ETH, type, 'dev0', { master: slaveType ? BRIDGE : '', slaveType, ipv4: null });
			expect(parseNmcliProfileBlocks(text, [ETH]).size).toBe(1);
		}
	});
});
