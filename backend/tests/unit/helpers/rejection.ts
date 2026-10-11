/**
 * The error a promise rejects with; fails when it resolves.
 *
 * Use instead of `expect(promise).rejects` / `.resolves` for anything that waits on the Windows
 * dataset worker: once a test has awaited one worker reply, Bun (1.4.2, 1.4.3) stops delivering
 * the worker's messages while `expect` waits on the next promise, and the test hangs. A plain
 * `await` keeps receiving them.
 */
export async function rejection(promise: Promise<unknown>): Promise<any> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('Expected the promise to reject, but it resolved');
}
