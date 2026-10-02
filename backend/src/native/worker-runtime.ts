import { parentPort } from 'node:worker_threads';
import { DBusTransportError, type DBusOptions, type DBusRequest } from './linux/dbus.ts';
import { WorkerDBusConnections, type BoundDBusEndpoint, type DBusEndpointRequest } from './linux/dbus-worker.ts';
import { readLinuxNetlinkState } from './linux/netlink.ts';
import { readNl80211Link, readNl80211Scan } from './linux/nl80211.ts';
import { readNativeLinuxNetwork, readNativeLinuxCapabilities, scanNativeLinuxWifi } from './linux/network-reader.ts';
import { NativeMutationJournal, type NativeMutationDomain, type NativeMutationRecord } from './mutation-journal.ts';
import { currentNativeProcessIdentity, getNativeBootId, observeNativeProcess } from './process-identity.ts';
import type { NativeProcessIdentity } from './mutation-proof.ts';
import type { NativeWorkerErrorData, NativeWorkerRequest, NativeWorkerResponse } from './worker-host.ts';

if (!parentPort) throw new Error('Native runtime must run in a worker');

const journals = new Map<string, NativeMutationJournal>();
const buses = new WorkerDBusConnections();

function journal(directory: string): NativeMutationJournal {
	let value = journals.get(directory);
	if (!value) {
		value = new NativeMutationJournal(directory);
		journals.set(directory, value);
	}
	return value;
}

async function dispatch(request: NativeWorkerRequest): Promise<unknown> {
	switch (request.method) {
		case 'identity.current':
			return { bootId: getNativeBootId(), executor: currentNativeProcessIdentity() };
		case 'identity.observe':
			return { bootId: getNativeBootId(), process: observeNativeProcess(request.args as NativeProcessIdentity) };
		case 'journal.read': {
			const args = request.args as { directory: string; domain: NativeMutationDomain };
			return journal(args.directory).read(args.domain);
		}
		case 'journal.begin': {
			const args = request.args as { directory: string; record: NativeMutationRecord };
			return journal(args.directory).begin(args.record);
		}
		case 'journal.update': {
			const args = request.args as { directory: string; record: NativeMutationRecord; revision: number };
			return journal(args.directory).update(args.record, args.revision);
		}
		case 'journal.finish': {
			const args = request.args as { directory: string; domain: NativeMutationDomain; operationId: string; revision: number; acknowledge?: boolean };
			return journal(args.directory).finish(args.domain, args.operationId, args.revision, args.acknowledge);
		}
		case 'linux.netlink':
			return readLinuxNetlinkState(request.args as { timeoutMs: number });
		case 'linux.network.snapshot':
			return readNativeLinuxNetwork(request.args as { timeoutMs: number });
		case 'linux.network.capabilities':
			return readNativeLinuxCapabilities(request.args as { timeoutMs: number });
		case 'linux.network.scan': {
			const args = request.args as { device: string; timeoutMs: number };
			return scanNativeLinuxWifi(args.device, args);
		}
		case 'linux.wifi.link': {
			const args = request.args as { index: number; timeoutMs: number };
			return readNl80211Link(args.index, { timeoutMs: args.timeoutMs });
		}
		case 'linux.wifi.scan': {
			const args = request.args as { index: number; timeoutMs: number };
			return readNl80211Scan(args.index, { timeoutMs: args.timeoutMs });
		}
		case 'linux.dbus': {
			const args = request.args as { options: DBusOptions; request: DBusRequest };
			return buses.read(args.options, args.request);
		}
		case 'linux.dbus.bind':
			return buses.bind(request.args as DBusEndpointRequest);
		case 'linux.dbus.call': {
			const args = request.args as { endpoint: BoundDBusEndpoint; request: DBusRequest };
			return buses.call(args.endpoint, args.request);
		}
		default:
			throw new Error(`Unknown native operation: ${request.method}`);
	}
}

function errorData(error: unknown): NativeWorkerErrorData {
	if (error instanceof DBusTransportError) return { name: error.name, message: error.message, stage: error.stage, mayHaveBeenSent: error.mayHaveBeenSent, errno: error.errno, reply: error.reply };
	return { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) };
}

parentPort.on('message', async (request: NativeWorkerRequest & { id: number; lane: 'read' | 'mutation' }) => {
	let response: NativeWorkerResponse;
	try {
		const dbusMutation = request.method === 'linux.dbus' && (request.args as { request: DBusRequest }).request.kind === 'mutation';
		if (request.lane === 'read' && (dbusMutation || ['linux.dbus.call', 'journal.begin', 'journal.update', 'journal.finish'].includes(request.method))) throw new Error('A read worker cannot execute mutations');
		response = { id: request.id, ok: true, value: await dispatch(request) };
	} catch (error) {
		response = { id: request.id, ok: false, error: errorData(error) };
	}
	parentPort!.postMessage(response);
});

process.on('exit', () => {
	buses.close();
	for (const value of journals.values()) value.close();
});
