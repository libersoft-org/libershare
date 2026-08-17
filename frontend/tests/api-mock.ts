/**
 * The one stand-in for `src/scripts/api.ts` that every unit test shares.
 *
 * There used to be one `mock.module()` per test file, which cannot work: the
 * registry `mock.module()` writes to is global, it rebinds modules that have
 * ALREADY been imported, and `mock.restore()` does not undo a module override at
 * all. Two files replacing the same module therefore leave the surviving fake
 * decided by load order — a test that passes alone and fails in the suite, or
 * worse, one that passes while running against another file's fake. Bun happens to
 * load and run each file before loading the next, so today the last registration
 * to run is always the current file's; nothing states that, and nothing would tell
 * us when it stops being true.
 *
 * So the module is replaced exactly once, from the preload, by an `api` object
 * whose identity never changes and whose behaviour is these three handlers. A test
 * sets the one it needs and {@link resetAPIMock} puts the defaults back, which is
 * ordinary mutable state and is order-independent by construction.
 */
export interface APIHandlers {
	/** Answers one RPC. The default refuses, so a test that forgot to arm it says so. */
	call: (method: string, params?: unknown) => Promise<unknown>;
	on: (event: string, handler: (data: never) => void) => void;
	subscribe: (event: string) => void;
}

/** What every test starts from — see {@link resetAPIMock}. */
function defaults(): APIHandlers {
	return {
		call: async (method: string) => {
			throw new Error(`no api.call handler is armed for "${method}"`);
		},
		on: () => {},
		subscribe: () => {},
	};
}

/** The handlers the fake `api` delegates to. Assign fields; never replace the object. */
export const apiHandlers: APIHandlers = defaults();

/** Put the default handlers back, so one test cannot arm another one's transport. */
export function resetAPIMock(): void {
	Object.assign(apiHandlers, defaults());
}

/**
 * The `api` the mocked module exports.
 *
 * Delegating rather than being replaced wholesale is what keeps this safe: modules
 * that captured `api` at import time keep the same object, so a handler assigned
 * after their import still reaches them.
 */
export const fakeAPI = {
	call: <T>(method: string, params?: unknown): Promise<T> => apiHandlers.call(method, params) as Promise<T>,
	on: (event: string, handler: (data: never) => void): void => apiHandlers.on(event, handler),
	subscribe: (event: string): void => apiHandlers.subscribe(event),
};
