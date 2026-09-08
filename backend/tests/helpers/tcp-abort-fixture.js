import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { tcp } from '@libp2p/tcp';
import { defaultLogger } from '@libp2p/logger';
import { multiaddr } from '@multiformats/multiaddr';
import { anySignal } from 'any-signal';
import { installRuntimeErrorHandlers } from '../../src/runtime-errors.ts';

const mode = process.argv[2];
const uncaught = [];
// Observation only: the production handler decides whether the child exits.
process.on('uncaughtExceptionMonitor', error => uncaught.push({ name: error.name, message: error.message, code: error.code ?? null }));
installRuntimeErrorHandlers();
const deadline = setTimeout(() => {
	console.error('TCP fixture deadline exceeded');
	process.exit(2);
}, 5000);
const records = [];
const originalConnect = net.connect;
net.connect = (...args) => {
	const socket = originalConnect(...args);
	const record = { socket, closed: false };
	record.closing = new Promise(resolve =>
		socket.once('close', () => {
			record.closed = true;
			resolve();
		})
	);
	records.push(record);
	return socket;
};
const peers = new Set();
const serverErrors = [];
const server = net.createServer(socket => {
	peers.add(socket);
	socket.on('close', () => peers.delete(socket));
	socket.on('error', error => {
		if (error.code !== 'ECONNRESET') serverErrors.push(error.message);
	});
	socket.on('data', data => socket.write(data));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = multiaddr(`/ip4/127.0.0.1/tcp/${server.address().port}`);
const transport = tcp()({ logger: defaultLogger() });
const controller = new AbortController();
const signal = anySignal([controller.signal]);
const reason = new DOMException('TCP fixture timeout', 'TimeoutError');
let rejected = null;
let initialErrorListeners = null;
let consumerError = null;
let echo = null;
try {
	if (mode === 'pre-aborted') controller.abort(reason);
	if (mode === 'refused') await new Promise(resolve => server.close(resolve));
	const connecting = transport._connect(address, { signal });
	if (mode === 'timeout' || mode === 'cancel') queueMicrotask(() => controller.abort(mode === 'timeout' ? reason : new DOMException('TCP fixture cancelled', 'AbortError')));
	try {
		const socket = await connecting;
		initialErrorListeners = socket.listenerCount('error');
		if (mode === 'established-error') {
			socket.once('error', error => {
				consumerError = error.message;
			});
			socket.destroy(new Error('established socket failure'));
		} else if (mode === 'unowned-established-error') {
			socket.destroy(new Error('unowned established socket failure'));
		} else {
			const response = once(socket, 'data');
			socket.write('actual TCP echo');
			echo = (await response)[0].toString();
			socket.end();
		}
	} catch (error) {
		rejected = { name: error.name, message: error.message, code: error.code ?? null };
	}
	signal.clear();
	await Promise.all(records.map(record => record.closing));
	await delay(20);
	const initialSockets = records.map(record => ({ closed: record.closed, destroyed: record.socket.destroyed, errorListeners: record.socket.listenerCount('error') }));
	let recoveryEcho = null;
	let recoverySocket = null;
	if (mode === 'timeout' || mode === 'cancel' || mode === 'pre-aborted') {
		const recoverySignal = anySignal([new AbortController().signal]);
		const socket = await transport._connect(address, { signal: recoverySignal });
		const response = once(socket, 'data');
		socket.write('connection after cancellation');
		recoveryEcho = (await response)[0].toString();
		socket.end();
		recoverySignal.clear();
		await records.at(-1).closing;
		await delay(20);
		recoverySocket = { closed: records.at(-1).closed, destroyed: socket.destroyed, errorListeners: socket.listenerCount('error') };
	}
	await delay(20);
	console.log('RESULT:' + JSON.stringify({ rejected, uncaught, initialSockets, initialErrorListeners, consumerError, echo, recoveryEcho, recoverySocket, serverErrors }));
} finally {
	signal.clear();
	for (const record of records) record.socket.destroy();
	for (const peer of peers) peer.destroy();
	if (server.listening) await new Promise(resolve => server.close(resolve));
	clearTimeout(deadline);
}
