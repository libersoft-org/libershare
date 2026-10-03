import type { NetIPv4Config } from '@shared';
import { NativeMutationStopped, NativeMutationUnknown, type NativeMutationContext } from '../mutation-host.ts';
import { NativeWorkerChannel, NativeWorkerFailure } from '../worker-host.ts';
import { isDarwinIPv4Recovery, type DarwinIPv4Recovery, type DarwinIPv4Observation } from './network-mutation-state.ts';
import type { DarwinIPv4Prepare, DarwinIPv4Write, DarwinIPv4WriteResult } from './network-mutation-worker.ts';

export { isDarwinIPv4Recovery, type DarwinIPv4Recovery } from './network-mutation-state.ts';
export const darwinNetworkReader: NativeWorkerChannel = new NativeWorkerChannel('read');
export interface DarwinIPv4MutationDeps {
	prepare(request: DarwinIPv4Prepare): Promise<{ token: string; recovery: DarwinIPv4Recovery }>;
	write(request: DarwinIPv4Write): Promise<DarwinIPv4WriteResult>;
	observe(saved: DarwinIPv4Recovery, timeoutMs: number): Promise<DarwinIPv4Observation>;
	release(token: string): Promise<void>;
	now(): number;
	sleep(ms: number): Promise<void>;
	close(): void;
}
function dependencies(): DarwinIPv4MutationDeps {
	const writer = new NativeWorkerChannel('mutation');
	return {
		prepare: args => writer.call({ method: 'darwin.network.ipv4.prepare', args }),
		write: args => writer.call({ method: 'darwin.network.ipv4.write', args }),
		observe: (saved, timeoutMs) => darwinNetworkReader.call({ method: 'darwin.network.ipv4.observe', args: { saved } }, timeoutMs),
		release: token => writer.call({ method: 'darwin.network.ipv4.release', args: { token } }),
		now: () => performance.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
		close: () => { writer.close(); },
	};
}

export async function observeNativeDarwinIPv4(saved: DarwinIPv4Recovery, timeoutMs: number): Promise<DarwinIPv4Observation> {
	if (!isDarwinIPv4Recovery(saved)) throw new Error('Invalid macOS IPv4 recovery snapshot');
	return darwinNetworkReader.call({ method: 'darwin.network.ipv4.observe', args: { saved } }, timeoutMs);
}

export async function applyNativeDarwinIPv4(context: NativeMutationContext, device: string, desired: NetIPv4Config, options: { addressingChanged: boolean; requireLease: boolean }, supplied?: DarwinIPv4MutationDeps): Promise<void> {
	const deps = supplied ?? dependencies();
	let prepared: { token: string; recovery: DarwinIPv4Recovery } | undefined;
	let uncertain = false, committed = false;
	try {
		prepared = await deps.prepare({ device, desired, ...options });
		await context.recordRecovery({ darwinIPv4: JSON.parse(JSON.stringify(prepared.recovery)) });
		const write = async (restore: boolean): Promise<void> => {
			let reply: DarwinIPv4WriteResult;
			try { reply = await context.call({ kind: 'boot' }, async () => ({ known: true, value: await deps.write({ token: prepared!.token, restore }) })); }
			catch (error) {
				uncertain = error instanceof NativeMutationUnknown || (error instanceof NativeWorkerFailure && error.mayHaveRun);
				throw error;
			}
			committed ||= reply.ok || reply.commitAttempted;
			if (!reply.ok) throw new Error(reply.error);
		};
		const verify = async (original: boolean): Promise<void> => {
			const deadline = deps.now() + Math.min(20000, context.remainingMs());
			for (;;) {
				const state = await deps.observe(prepared!.recovery, Math.max(1, Math.min(5000, context.remainingMs())));
				if (original ? state.original : state.target) return;
				if (deps.now() >= deadline) throw new Error(original ? 'The macOS network snapshot was not restored' : 'macOS did not apply the requested IPv4/DNS policy');
				await deps.sleep(200);
			}
		};
		try { await write(false); await verify(false); }
		catch (error) {
			if (uncertain || error instanceof NativeMutationStopped || !committed) throw error;
			try { await write(true); await verify(true); }
			catch (restoreError) {
				if (uncertain || restoreError instanceof NativeMutationStopped) throw restoreError;
				throw new Error(`Network apply failed: ${String(error)}; rollback failed: ${String(restoreError)}`);
			}
			throw error;
		}
	} finally {
		// Releasing the local lock never commits or applies staged preferences.
		try { if (prepared && !uncertain) await deps.release(prepared.token); } finally { deps.close(); }
	}
}
