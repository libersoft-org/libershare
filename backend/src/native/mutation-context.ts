import { AsyncLocalStorage } from 'node:async_hooks';
import type { NativeMutationContext } from './mutation-host.ts';

const current = new AsyncLocalStorage<NativeMutationContext>();

export function requireNativeMutationContext(): NativeMutationContext {
	const context = current.getStore();
	if (!context) throw new Error('Native mutation requires durable ownership');
	return context;
}

export function withNativeMutationContext<T>(context: NativeMutationContext, action: () => Promise<T>): Promise<T> {
	if (current.getStore()) throw new Error('Native mutation ownership cannot be nested');
	return current.run(context, action);
}

const dispatchLimit = new AsyncLocalStorage<() => boolean>();

/**
 * Run `action` under the caller's own deadline for starting native writes. The mutation host checks
 * it right before each dispatch, after any preparation and journal write; a write already sent is
 * never cut short.
 */
export function withDispatchDeadline<T>(expired: () => boolean, action: () => Promise<T>): Promise<T> {
	return dispatchLimit.run(expired, action);
}

export function dispatchDeadlinePassed(): boolean {
	return dispatchLimit.getStore()?.() ?? false;
}
