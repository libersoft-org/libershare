import assert from 'node:assert/strict';
import type { NetworkStateInfo, SystemTimeResult, SystemTimeStatus } from '@shared';

interface Reply {
	id: string;
	result?: unknown;
	error?: string;
	errorDetail?: string;
}

assert.equal(process.platform, 'linux');
assert.equal(process.arch, process.env['EXPECTED_NATIVE_ARCH']);
const token = process.env['LISH_TOKEN'];
assert.ok(token);
const socket = new WebSocket(`ws://127.0.0.1:1158/?token=${encodeURIComponent(token)}`);
let sequence = 0;

async function rpc(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
	const id = String(++sequence);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.removeEventListener('message', receive);
			reject(new Error(`${method} did not answer`));
		}, 30000);
		function receive(event: MessageEvent): void {
			const reply = JSON.parse(String(event.data)) as Reply;
			if (reply.id !== id) return;
			clearTimeout(timer);
			socket.removeEventListener('message', receive);
			resolve(reply);
		}
		socket.addEventListener('message', receive);
		socket.send(JSON.stringify({ id, method, params }));
	});
}

try {
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Docker API did not connect')), 10000);
		socket.addEventListener(
			'open',
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true }
		);
		socket.addEventListener(
			'error',
			() => {
				clearTimeout(timer);
				reject(new Error('Docker API connection failed'));
			},
			{ once: true }
		);
	});
	const networkReply = await rpc('system.network');
	assert.equal(networkReply.error, undefined);
	const network = networkReply.result as NetworkStateInfo;
	assert.equal(network.known, true);
	assert.ok(!network.stale);
	assert.equal(network.capabilities.ipv4, false);
	assert.equal(network.capabilities.wifi, false);
	assert.ok(network.interfaces.length > 0, 'The isolated Docker bridge must provide a real interface');
	const target = network.interfaces.find(value => value.addresses.some(address => address.family === 'ipv4'));
	assert.ok(target, 'The Docker interface must have a real IPv4 address');
	const address = target.addresses.find(value => value.family === 'ipv4');
	const networkWrite = await rpc('system.networkApply', {
		interfaceID: target.id,
		config: { mode: 'dhcp' },
		expected: { mode: target.ipv4Mode, address: address?.address ?? null, prefixLength: address?.prefixLength ?? null, gateway: target.gateway ?? null, dns: target.dns },
	});
	assert.ok(networkWrite.error, 'A valid network write must be refused by the container');
	assert.equal(networkWrite.error, network.detail === 'addressesOnly' ? 'NETCONFIG_STALE' : 'NETCONFIG_UNSUPPORTED');
	const timeReply = await rpc('system.getTime');
	assert.equal(timeReply.error, undefined);
	const time = timeReply.result as SystemTimeStatus;
	assert.ok(Number.isFinite(time.nowMs));
	assert.ok(Object.values(time.capabilities).every(value => value === false));
	const timeWrite = await rpc('system.setNtpEnabled', { enabled: false });
	assert.equal(timeWrite.error, undefined);
	const refused = timeWrite.result as SystemTimeResult;
	assert.equal(refused.success, false);
	assert.ok(['unsupported', 'permission-denied'].includes(refused.outcome));
	assert.notEqual(refused.changed, true);
	const afterReply = await rpc('system.network');
	assert.equal(afterReply.error, undefined);
	assert.deepEqual((afterReply.result as NetworkStateInfo).interfaces, network.interfaces);
	assert.equal((afterReply.result as NetworkStateInfo).mutation, undefined);
	console.log(JSON.stringify({ platform: process.platform, arch: process.arch, networkRead: true, timeRead: true, networkWriteRefused: networkWrite.error, timeWriteRefused: refused.outcome, networkUnchanged: true }));
} finally {
	socket.close();
}
