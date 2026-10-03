import { parentPort } from 'node:worker_threads';
import { DBusTransportError, type DBusOptions, type DBusRequest } from './linux/dbus.ts';
import { WorkerDBusConnections, type BoundDBusEndpoint, type DBusEndpointRequest } from './linux/dbus-worker.ts';
import { readLinuxNetlinkState } from './linux/netlink.ts';
import { readNl80211Link, readNl80211Scan } from './linux/nl80211.ts';
import { readNativeLinuxNetwork, readNativeLinuxCapabilities, scanNativeLinuxWifi } from './linux/network-reader.ts';
import { readNativeWindowsNetwork, readNativeWindowsNetworkCapabilities } from './win32/network-reader.ts';
import { readWindowsIPv4Snapshot } from './win32/network-mutation-state.ts';
import { executeWindowsIPv4Write, type WindowsIPv4Write } from './win32/network-mutation-worker.ts';
import { matchingAuthenticodeSignatures, readAuthenticodeSignature } from './win32/authenticode.ts';
import { readWindowsTimeSnapshot, type WindowsTimeSnapshotRequest } from './win32/time-state.ts';
import { executeWindowsTimeWrite, type WindowsTimeWrite } from './win32/time-worker.ts';
import { readMacCodeIdentity } from './darwin/security.ts';
import { readMacVolume, writeMacVolume } from './darwin/audio.ts';
import { openMacPath } from './darwin/workspace.ts';
import { openWindowsPath } from './win32/shell.ts';
import { readNativeDarwinTimeStatus } from './darwin/time-reader.ts';
import { readDarwinTimeSnapshot, type DarwinTimeSnapshotRequest } from './darwin/time-state.ts';
import { executeDarwinTimeWrite, type DarwinTimeWrite } from './darwin/time-worker.ts';
import { readNativeDarwinNetwork } from './darwin/network-reader.ts';
import { observeDarwinIPv4, type DarwinIPv4Recovery } from './darwin/network-mutation-state.ts';
import { DarwinNetworkMutationWorker, type DarwinIPv4Prepare, type DarwinIPv4Write } from './darwin/network-mutation-worker.ts';
import { readNativeLinuxTimeStatus, readNativeTimedatedEnvironment } from './linux/time-reader.ts';
import { readTimesyncdConfiguration } from './linux/systemd-files.ts';
import { LinuxTimeJobWorker, type SetNativeNtpRequest, type RestartNativeTimeUnitRequest } from './linux/time-mutation-jobs.ts';
import { readLinuxTimeSnapshot, type LinuxTimeSnapshotRequest } from './linux/time-mutation-state.ts';
import { readNativeTimeServiceIdentity } from './linux/time-mutation-nss.ts';
import { PulseVolumeMonitor, readLinuxVolume, writeLinuxVolume } from './linux/pulse-volume.ts';
import { closeAllPulseSessions } from './linux/pulse.ts';
import { openLinuxPath, type LinuxOpenRequest } from './linux/gio.ts';
import { NativeMutationJournal, type NativeMutationDomain, type NativeMutationRecord } from './mutation-journal.ts';
import { observeHelperOperation, readTrustedHelperResult, type HelperOperationRule } from './helper-results.ts';
import { currentNativeProcessIdentity, getNativeBootId, observeNativeProcess } from './process-identity.ts';
import type { NativeProcessIdentity } from './mutation-proof.ts';
import type { NativeWorkerErrorData, NativeWorkerRequest, NativeWorkerResponse } from './worker-host.ts';

if (!parentPort) throw new Error('Native runtime must run in a worker');

const journals = new Map<string, NativeMutationJournal>();
const buses = new WorkerDBusConnections();
let timeJobs: LinuxTimeJobWorker | undefined;
let volumeMonitor: PulseVolumeMonitor | undefined;
let darwinNetwork: DarwinNetworkMutationWorker | undefined;

function macNetwork(): DarwinNetworkMutationWorker {
	return (darwinNetwork ??= new DarwinNetworkMutationWorker());
}

function jobs(): LinuxTimeJobWorker {
	return (timeJobs ??= new LinuxTimeJobWorker());
}

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
		case 'worker.close':
			closeResources();
			return;
		case 'identity.current':
			return { bootId: getNativeBootId(), executor: currentNativeProcessIdentity() };
		case 'helper.observe':
			return observeHelperOperation(request.args as HelperOperationRule);
		case 'helper.receipt':
			return readTrustedHelperResult(request.args as Parameters<typeof readTrustedHelperResult>[0]);
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
		case 'linux.open':
			return openLinuxPath(request.args as LinuxOpenRequest);
		case 'linux.volume.read':
			return readLinuxVolume(request.args as { timeoutMs: number });
		case 'linux.volume.write':
			return writeLinuxVolume(request.args as { percent: number; timeoutMs: number });
		case 'linux.volume.monitor.start':
			if (volumeMonitor) throw new Error('Volume monitor already started');
			volumeMonitor = new PulseVolumeMonitor();
			await volumeMonitor.start(
				() => parentPort!.postMessage({ event: 'linux.volume.changed' }),
				() => parentPort!.postMessage({ event: 'linux.volume.exited' })
			);
			return;
		case 'linux.volume.monitor.stop':
			volumeMonitor?.close();
			volumeMonitor = undefined;
			return;
		case 'win32.network.snapshot':
			return readNativeWindowsNetwork();
		case 'win32.network.capabilities':
			return readNativeWindowsNetworkCapabilities();
		case 'win32.network.ipv4.read':
			return readWindowsIPv4Snapshot((request.args as { guid: string }).guid);
		case 'win32.network.ipv4.write':
			return executeWindowsIPv4Write(request.args as WindowsIPv4Write);
		case 'win32.signature':
			return readAuthenticodeSignature((request.args as { path: string }).path);
		case 'win32.open':
			return openWindowsPath((request.args as { path: string }).path);
		case 'darwin.open':
			return openMacPath((request.args as { path: string }).path);
		case 'darwin.volume.read':
			return readMacVolume();
		case 'darwin.volume.write':
			return writeMacVolume((request.args as { percent: number }).percent);
		case 'darwin.time.status':
			return readNativeDarwinTimeStatus();
		case 'darwin.time.snapshot':
			return readDarwinTimeSnapshot((request.args ?? {}) as DarwinTimeSnapshotRequest);
		case 'darwin.time.write':
			return executeDarwinTimeWrite(request.args as DarwinTimeWrite);
		case 'win32.time.snapshot':
			return readWindowsTimeSnapshot((request.args ?? {}) as WindowsTimeSnapshotRequest);
		case 'win32.time.write':
			return executeWindowsTimeWrite(request.args as WindowsTimeWrite);
		case 'win32.signatures.match':
			return matchingAuthenticodeSignatures((request.args as { paths: string[] }).paths);
		case 'darwin.signature': {
			const args = request.args as { path: string; deep?: boolean };
			return readMacCodeIdentity(args.path, args.deep);
		}
		case 'darwin.network.read':
			return readNativeDarwinNetwork();
		case 'darwin.network.ipv4.observe':
			return observeDarwinIPv4((request.args as { saved: DarwinIPv4Recovery }).saved);
		case 'darwin.network.ipv4.prepare':
			return macNetwork().prepare(request.args as DarwinIPv4Prepare);
		case 'darwin.network.ipv4.write':
			return macNetwork().write(request.args as DarwinIPv4Write);
		case 'darwin.network.ipv4.release':
			return macNetwork().release((request.args as { token: string }).token);
		case 'linux.time.status':
			return readNativeLinuxTimeStatus(request.args as { timeoutMs: number });
		case 'linux.time.environment':
			return readNativeTimedatedEnvironment(request.args as { timeoutMs: number });
		case 'linux.time.configuration':
			return readTimesyncdConfiguration();
		case 'linux.time.snapshot':
			return readLinuxTimeSnapshot((request.args ?? {}) as LinuxTimeSnapshotRequest);
		case 'linux.time.service-identity':
			return readNativeTimeServiceIdentity((request.args as { timeoutMs: number }).timeoutMs);
		case 'linux.time.jobs.bind':
			return jobs().bind(request.args as DBusEndpointRequest);
		case 'linux.time.jobs.set-ntp':
			return jobs().setNtp(request.args as SetNativeNtpRequest);
		case 'linux.time.jobs.restart':
			return jobs().restart(request.args as RestartNativeTimeUnitRequest);
		case 'linux.time.jobs.state':
			return jobs().readNtpState((request.args as { timeoutMs: number }).timeoutMs);
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
		if (request.lane === 'read' && (dbusMutation || ['linux.dbus.call', 'linux.time.jobs.set-ntp', 'linux.time.jobs.restart', 'linux.volume.write', 'linux.volume.monitor.start', 'linux.volume.monitor.stop', 'win32.network.ipv4.write', 'win32.time.write', 'darwin.volume.write', 'darwin.time.write', 'darwin.network.ipv4.prepare', 'darwin.network.ipv4.write', 'darwin.network.ipv4.release', 'journal.begin', 'journal.update', 'journal.finish'].includes(request.method))) throw new Error('A read worker cannot execute mutations');
		response = { id: request.id, ok: true, value: await dispatch(request) };
	} catch (error) {
		response = { id: request.id, ok: false, error: errorData(error) };
	}
	parentPort!.postMessage(response);
});

function closeResources(): void {
	buses.close();
	timeJobs?.close();
	timeJobs = undefined;
	volumeMonitor?.close();
	volumeMonitor = undefined;
	closeAllPulseSessions();
	darwinNetwork?.close();
	darwinNetwork = undefined;
	for (const value of journals.values()) value.close();
	journals.clear();
}

process.on('exit', closeResources);
