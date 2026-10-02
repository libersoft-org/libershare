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
