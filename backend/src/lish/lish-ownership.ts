import { Mutex } from 'async-mutex';

interface Owner {
	readonly mutex: Mutex;
	users: number;
}

const owners = new Map<string, Owner>();

/**
 * Run `action` as the only owner of one LISH ID. Imports, deletes, a local `.lish` download and a
 * downloader's manifest write all take it, so a refused operation never stops or replaces work
 * that another one already started for the same ID. IDs are independent of each other.
 *
 * `signal` makes the wait abortable: a downloader being destroyed by the current owner stops
 * waiting at once instead of holding up the `destroy()` that owner is waiting for. A lock granted
 * after the abort is released without running `action`.
 */
export async function withLISHOwnership<T>(lishID: string, action: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
	let owner = owners.get(lishID);
	if (!owner) {
		owner = { mutex: new Mutex(), users: 0 };
		owners.set(lishID, owner);
	}
	owner.users++;
	try {
		const release = await acquire(owner.mutex, signal);
		try {
			return await action();
		} finally {
			release();
		}
	} finally {
		if (--owner.users === 0) owners.delete(lishID);
	}
}

function acquire(mutex: Mutex, signal: AbortSignal | undefined): Promise<() => void> {
	if (!signal) return mutex.acquire();
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		let settled = false;
		const onAbort = (): void => {
			if (settled) return;
			settled = true;
			reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
		mutex.acquire().then(release => {
			signal.removeEventListener('abort', onAbort);
			if (settled) {
				release();
				return;
			}
			settled = true;
			resolve(release);
		}, reject);
	});
}
