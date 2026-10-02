import { expect } from 'bun:test';

export async function expectWorkerRejection(promise: Promise<unknown>, message: string): Promise<void> {
	// Bun 1.3.14/1.4.1 on ARM64 can block Worker messages inside rejects.toThrow.
	const error = await promise.then(() => undefined, error => error);
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message).toContain(message);
}
