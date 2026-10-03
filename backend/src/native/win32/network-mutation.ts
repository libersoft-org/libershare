import { validateIPv4Config, type NetIPv4Config } from '@shared';
import { NativeMutationStopped, NativeMutationUnknown, type NativeMutationContext } from '../mutation-host.ts';
import { NativeWorkerChannel, NativeWorkerFailure } from '../worker-host.ts';
import { windowsDnsChanges } from './dns.ts';
import { assertRestorableWindowsIPv4, assertWindowsIPv4Target, isWindowsIPv4Recovery, sameWindowsInterface, usableWindowsAddress, windowsIPv4Fingerprint, type WindowsIPv4Recovery, type WindowsIPv4Snapshot } from './network-mutation-state.ts';
import type { WindowsIPv4Write, WindowsIPv4WriteResult } from './network-mutation-worker.ts';

export type { WindowsIPv4Recovery } from './network-mutation-state.ts';
export { isWindowsIPv4Recovery } from './network-mutation-state.ts';
export interface WindowsIPv4MutationOptions {
	readonly addressingChanged: boolean;
	readonly requireLease: boolean;
	readonly readTimeoutMs?: number;
}
export interface WindowsIPv4MutationDeps {
	read(guid: string, timeoutMs: number): Promise<WindowsIPv4Snapshot>;
	write(request: WindowsIPv4Write): Promise<WindowsIPv4WriteResult>;
	now(): number;
	sleep(ms: number): Promise<void>;
	close(): void;
}
function dependencies(): WindowsIPv4MutationDeps {
	const reader = new NativeWorkerChannel('read'),
		writer = new NativeWorkerChannel('mutation');
	return {
		read: (guid, timeoutMs) => reader.call({ method: 'win32.network.ipv4.read', args: { guid } }, timeoutMs),
		write: request => writer.call({ method: 'win32.network.ipv4.write', args: request }),
		now: () => performance.now(),
		sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
		close: () => {
			reader.close();
			writer.close();
		},
	};
}

function matchesOriginal(current: WindowsIPv4Snapshot, saved: WindowsIPv4Recovery): boolean {
	if (!sameWindowsInterface(current, saved.snapshot)) return false;
	const before = saved.snapshot;
	if (!before.stores.ActiveStore.dhcp) return windowsIPv4Fingerprint(current) === saved.fingerprint && current.stores.ActiveStore.addresses.every(usableWindowsAddress);
	try {
		assertRestorableWindowsIPv4(current);
	} catch {
		return false;
	}
	if (!current.stores.ActiveStore.dhcp) return false;
	if (before.stores.ActiveStore.addresses.some(usableWindowsAddress) && !current.stores.ActiveStore.addresses.some(usableWindowsAddress)) return false;
	if (before.stores.ActiveStore.routes.length && !current.stores.ActiveStore.routes.length) return false;
	return before.dns.every(old => {
		const policy = current.dns.find(value => value.family === old.family);
		return policy && policy.automatic === old.automatic && (old.automatic || JSON.stringify(policy.servers) === JSON.stringify(old.servers));
	});
}

export interface WindowsIPv4Observation {
	readonly original: boolean;
	readonly target: boolean;
	readonly fingerprint: string;
	readonly addressCounts: { readonly active: number; readonly persistent: number };
	readonly routeCounts: { readonly active: number; readonly persistent: number };
}
export async function observeNativeWindowsIPv4(saved: WindowsIPv4Recovery, timeoutMs: number, supplied?: WindowsIPv4MutationDeps): Promise<WindowsIPv4Observation> {
	if (!isWindowsIPv4Recovery(saved)) throw new Error('Invalid Windows IPv4 recovery snapshot');
	const deps = supplied ?? dependencies();
	try {
		const current = await deps.read(saved.snapshot.guid, timeoutMs);
		let target = false;
		try {
			assertWindowsIPv4Target(current, saved);
			target = true;
		} catch {
			/* An unmatched policy remains interrupted. */
		}
		return { original: matchesOriginal(current, saved), target, fingerprint: windowsIPv4Fingerprint(current), addressCounts: { active: current.stores.ActiveStore.addresses.length, persistent: current.stores.PersistentStore.addresses.length }, routeCounts: { active: current.stores.ActiveStore.routes.length, persistent: current.stores.PersistentStore.routes.length } };
	} finally {
		deps.close();
	}
}

export async function applyNativeWindowsIPv4(context: NativeMutationContext, guid: string, desired: NetIPv4Config, options: WindowsIPv4MutationOptions, supplied?: WindowsIPv4MutationDeps): Promise<void> {
	if (validateIPv4Config(desired)) throw new Error('Invalid IPv4 configuration');
	const deps = supplied ?? dependencies();
	const readTimeout = options.readTimeoutMs ?? 15000;
	let addressingWritten = false,
		dnsWritten = false;
	try {
		const read = (): Promise<WindowsIPv4Snapshot> => deps.read(guid, Math.max(1, Math.min(readTimeout, context.remainingMs())));
		const snapshot = await read();
		if (options.addressingChanged) assertRestorableWindowsIPv4(snapshot);
		const saved: WindowsIPv4Recovery = { snapshot, fingerprint: windowsIPv4Fingerprint(snapshot), desired, addressingChanged: options.addressingChanged, requireLease: options.requireLease };
		await context.recordRecovery({ windowsIPv4: JSON.parse(JSON.stringify(saved)) });
		const write = async (step: WindowsIPv4Write['step']): Promise<void> => {
			const reply = await context.call({ kind: 'boot' }, async () => {
				const result = await deps.write({ identity: snapshot, step });
				return result.sent && ('error' in result || result.result.outcome === 'unknown') ? { known: false } : { known: true, value: result };
			});
			if (!reply.sent) throw new Error(reply.error);
			if ('error' in reply) throw new NativeMutationUnknown();
			if (reply.result.outcome !== 'rejected') {
				if (step.kind === 'dns') dnsWritten = true;
				else addressingWritten = true;
			}
			if (reply.result.outcome !== 'ok') throw new Error(`Windows ${step.kind} failed: HRESULT 0x${(reply.result.hresult >>> 0).toString(16)}, ReturnValue ${reply.result.returnValue}`);
		};
		const wait = async (matches: (value: WindowsIPv4Snapshot) => boolean, ms: number, message: string): Promise<void> => {
			const deadline = deps.now() + Math.min(ms, context.remainingMs());
			for (;;) {
				const current = await read();
				if (!sameWindowsInterface(current, snapshot)) throw new Error('Interface identity changed');
				if (current.stores.ActiveStore.addresses.some(value => value.state === 2)) throw new Error('IPv4 address is duplicate');
				if (matches(current)) return;
				if (deps.now() >= deadline) throw new Error(message);
				await deps.sleep(100);
			}
		};
		const clearAddressing = async (): Promise<void> => {
			// Deleting a persistent object may also delete its active counterpart.
			for (const store of ['PersistentStore', 'ActiveStore'] as const) {
				for (const row of (await read()).stores[store].addresses) await write({ kind: 'delete', path: row.path, store });
				for (const row of (await read()).stores[store].routes) await write({ kind: 'delete', path: row.path, store });
			}
		};
		const setDhcp = async (enabled: boolean): Promise<void> => {
			const active = (await read()).stores.ActiveStore;
			if (active.dhcp !== enabled) await write({ kind: 'dhcp', path: active.interfacePath, store: 'ActiveStore', enabled });
			const persistent = (await read()).stores.PersistentStore;
			if (persistent.dhcp !== null && persistent.dhcp !== enabled) await write({ kind: 'dhcp', path: persistent.interfacePath, store: 'PersistentStore', enabled });
		};
		const createStatic = async (address: string, prefixLength: number, gateway?: string, metric?: number): Promise<void> => {
			await setDhcp(false);
			await write({ kind: 'address', address, prefixLength });
			await wait(value => value.stores.ActiveStore.addresses.some(row => row.address === address && row.prefixLength === prefixLength && usableWindowsAddress(row)), 10000, 'IPv4 address did not become usable');
			if (gateway) await write({ kind: 'route', gateway, ...(metric === undefined ? {} : { metric }) });
		};
		try {
			if (options.addressingChanged) {
				await clearAddressing();
				if (desired.mode === 'dhcp') {
					await setDhcp(true);
					if (options.requireLease) await wait(value => value.stores.ActiveStore.addresses.some(usableWindowsAddress), 20000, 'DHCP apply did not obtain a usable lease');
				} else await createStatic(desired.address!, desired.prefixLength!, desired.gateway, snapshot.stores.ActiveStore.routes[0]?.metric);
			}
			for (const change of windowsDnsChanges(snapshot.dns, desired.dns)) await write({ kind: 'dns', ...change });
			assertWindowsIPv4Target(await read(), saved);
		} catch (error) {
			if (error instanceof NativeMutationUnknown || error instanceof NativeMutationStopped || (error instanceof NativeWorkerFailure && error.mayHaveRun)) throw error;
			try {
				if (addressingWritten) {
					await clearAddressing();
					if (snapshot.stores.ActiveStore.dhcp) {
						await setDhcp(true);
						const needAddress = snapshot.stores.ActiveStore.addresses.some(usableWindowsAddress),
							needRoute = snapshot.stores.ActiveStore.routes.length > 0;
						if (needAddress || needRoute) await wait(value => (!needAddress || value.stores.ActiveStore.addresses.some(usableWindowsAddress)) && (!needRoute || value.stores.ActiveStore.routes.length > 0), 20000, 'DHCP rollback did not restore a usable lease');
					} else {
						const address = snapshot.stores.ActiveStore.addresses[0]!,
							route = snapshot.stores.ActiveStore.routes[0];
						await createStatic(address.address, address.prefixLength, route?.gateway, route?.metric);
					}
				}
				if (dnsWritten) for (const policy of snapshot.dns) await write({ kind: 'dns', policy, servers: policy.automatic ? null : policy.servers });
				if ((addressingWritten || dnsWritten) && !matchesOriginal(await read(), saved)) throw new Error('IPv4 rollback did not restore the original policy');
			} catch (rollbackError) {
				if (rollbackError instanceof NativeMutationUnknown || rollbackError instanceof NativeMutationStopped) throw rollbackError;
				throw new Error(`Network apply failed: ${String(error)}; rollback failed: ${String(rollbackError)}`);
			}
			throw error;
		}
	} finally {
		deps.close();
	}
}
