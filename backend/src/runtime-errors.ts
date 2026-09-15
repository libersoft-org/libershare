import { errorName, isTransientError } from './transient-errors.ts';

// Rate-limiter for the highest-frequency transient error coming from gossipsub
// internals (StreamStateError: "Cannot write to a stream that is closed").
// This is a known issue in @chainsafe/libp2p-gossipsub where sendRpc does not
// catch sync throws from rawStream.send() on closed streams. Logging each one
// produces ~5000 warn/hour of pure noise. We keep an occasional summary so the
// condition is still observable.
const transientLogState = new Map<string, { count: number; lastLogAt: number }>();
const TRANSIENT_LOG_INTERVAL_MS = 60_000;
function logTransientRateLimited(kind: 'error' | 'rejection', name: string, message: string): void {
	const key = `${kind}:${name}`;
	const state = transientLogState.get(key) ?? { count: 0, lastLogAt: 0 };
	state.count++;
	const now = Date.now();
	if (now - state.lastLogAt >= TRANSIENT_LOG_INTERVAL_MS) {
		const suppressed = state.count > 1 ? ` (×${state.count} in last ${Math.round((now - state.lastLogAt) / 1000)}s)` : '';
		console.warn(`[WARN] Suppressed transient libp2p ${kind} (${name})${suppressed}: ${message}`);
		state.count = 0;
		state.lastLogAt = now;
	}
	transientLogState.set(key, state);
}

/** Install the process error policy before starting the network runtime. */
export function installRuntimeErrorHandlers(): void {
	process.on('uncaughtException', err => {
		if (isTransientError(err)) {
			const name = errorName(err);
			logTransientRateLimited('error', name, err.message);
			return;
		}
		const ctorName = (err as any)?.constructor?.name || '';
		const errName = (err as any)?.name || '';
		const errMessage = (err as any)?.message || '';
		const errStack = (err as any)?.stack || '';
		const errKeys = err && typeof err === 'object' ? Object.keys(err as any).join(',') : '';
		console.error(`[FATAL] Uncaught exception: ctor=${ctorName} name=${errName} msg=${errMessage} keys=${errKeys}`);
		console.error('[FATAL] stack:', errStack);
		console.error('[FATAL] full:', JSON.stringify(err, Object.getOwnPropertyNames(err as any)));
		process.exit(1);
	});

	process.on('unhandledRejection', (reason: any) => {
		if (isTransientError(reason)) {
			const name = errorName(reason);
			logTransientRateLimited('rejection', name, reason?.message ?? '');
			return;
		}
		const ctorName = reason?.constructor?.name || '';
		const errName = reason?.name || '';
		const errMessage = reason?.message || '';
		const errStack = reason?.stack || '';
		const errKeys = reason && typeof reason === 'object' ? Object.keys(reason).join(',') : '';
		console.error(`[FATAL] Unhandled rejection: ctor=${ctorName} name=${errName} msg=${errMessage} keys=${errKeys}`);
		console.error('[FATAL] stack:', errStack);
		console.error('[FATAL] full:', JSON.stringify(reason, Object.getOwnPropertyNames(reason)));
		process.exit(1);
	});
}
