import { expect, test } from 'bun:test';
import { WorkerDBusConnections, type DBusEndpointRequest } from '../../src/native/linux/dbus-worker.ts';
import { DBusTransportError, type DBusReply, type DBusRequest } from '../../src/native/linux/dbus.ts';

const request: DBusEndpointRequest = { options: {}, destination: 'org.example.Service', path: '/org/example/Service', interface: 'org.example.Service', timeoutMs: 1000 };

function reply(signature: string, values: DBusReply['values']): DBusReply {
	return { type: 'method_return', sender: 'org.freedesktop.DBus', signature, values, errorName: null, errorMessage: null };
}

function fixture() {
	const sent: DBusRequest[] = [];
	let opened = 0;
	let closed = 0;
	let failNext = false;
	const connections = new WorkerDBusConnections(
		() => {
			opened++;
			return {
				async call(value: DBusRequest): Promise<DBusReply> {
					sent.push(value);
					if (failNext) {
						failNext = false;
						throw new DBusTransportError('connection reset', 'process', true, 104);
					}
					switch (value.member) {
						case 'GetAll':
							return reply('a{sv}', [{}]);
						case 'GetNameOwner':
							return reply('s', [':1.42']);
						case 'GetId':
							return reply('s', ['a'.repeat(32)]);
						case 'GetConnectionUnixProcessID':
							return reply('u', [42]);
						default:
							return { ...reply('', []), sender: ':1.42' };
					}
				},
				close() {
					closed++;
				},
			};
		},
		pid => ({ pid, started: 'linux-starttime:123' })
	);
	return {
		connections,
		sent,
		opened: () => opened,
		closed: () => closed,
		fail: () => {
			failNext = true;
		},
	};
}

test('the mutation addresses the exact owner whose bus and process identity were recorded', async () => {
	const f = fixture();
	try {
		const endpoint = await f.connections.bind(request);
		expect(endpoint.rule).toEqual({ kind: 'dbus-process', destination: ':1.42', busId: 'a'.repeat(32), process: { pid: 42, started: 'linux-starttime:123' } });
		await f.connections.call(endpoint, { kind: 'mutation', destination: endpoint.rule.destination, path: request.path, interface: request.interface, member: 'Apply' });
		expect(f.sent[f.sent.length - 1]!.destination).toBe(':1.42');
		expect(f.sent.filter(value => value.member === 'GetConnectionUnixProcessID')[0]!.args).toEqual([':1.42']);
	} finally {
		f.connections.close();
	}
});

test('a failed connection is discarded for reads but cannot silently rebind an old mutation', async () => {
	const f = fixture();
	try {
		const endpoint = await f.connections.bind(request);
		f.fail();
		await expect(f.connections.call(endpoint, { kind: 'mutation', destination: ':1.42', path: request.path, interface: request.interface, member: 'Apply' })).rejects.toThrow('connection reset');
		expect(f.closed()).toBe(1);
		expect(f.sent.filter(value => value.member === 'Apply')).toHaveLength(1);
		await f.connections.read({}, { kind: 'read', destination: request.destination, path: request.path, interface: request.interface, member: 'GetAll' });
		expect(f.opened()).toBe(2);
		const error = await f.connections.call(endpoint, { kind: 'mutation', destination: ':1.42', path: request.path, interface: request.interface, member: 'Apply' }).catch(error => error);
		expect(error).toBeInstanceOf(DBusTransportError);
		expect((error as DBusTransportError).mayHaveBeenSent).toBe(false);
		expect(f.sent.filter(value => value.member === 'Apply')).toHaveLength(1);
	} finally {
		f.connections.close();
	}
});

test('an unbound write or changed destination is rejected before send', async () => {
	const f = fixture();
	try {
		const endpoint = await f.connections.bind(request);
		const size = f.sent.length;
		expect(() => f.connections.read({}, { kind: 'mutation', destination: request.destination, path: request.path, interface: request.interface, member: 'Apply' })).toThrow('Unbound mutation');
		await expect(f.connections.call(endpoint, { kind: 'mutation', destination: ':1.99', path: request.path, interface: request.interface, member: 'Apply' })).rejects.toThrow('no longer available');
		expect(f.sent).toHaveLength(size);
	} finally {
		f.connections.close();
	}
});
