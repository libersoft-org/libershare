import assert from 'node:assert/strict';
import { IPC_KIND } from '@shared';
import type { NativeFrame, TauriHost } from '../../src/scripts/tauri-transport.ts';

let httpCalls = 0;
let websocketCalls = 0;
let sequence = 0;
let openAttempts = 0;
const chunks: number[][] = [];
const host: TauriHost = { __BACKEND_IPC__: true };
Object.assign(globalThis, {
	window: host,
	fetch: (url: unknown) => {
		if (url === '/langs/en.json') return Promise.resolve(new Response(Bun.file(new URL('../../static/langs/en.json', import.meta.url))));
		httpCalls++;
		throw new Error('Desktop attempted backend HTTP');
	},
	WebSocket: class {
		constructor() {
			websocketCalls++;
			throw new Error('Desktop attempted WebSocket');
		}
	},
});
host.__TAURI_INTERNALS__ = {
	invoke: async <T>(command: string, args?: Record<string, unknown> | Uint8Array): Promise<T> => {
		if (command === 'backend_open') {
			if (++openAttempts === 1) throw new Error('BACKEND_STARTING');
			return 7 as T;
		}
		if (command === 'backend_send') {
			assert(args instanceof Uint8Array);
			assert.equal(new DataView(args.buffer, args.byteOffset).getUint32(1), 7);
			const payload = args.subarray(5);
			let request: { id: string; method: string; params: Record<string, unknown> };
			if (args[0] === IPC_KIND.Text) request = JSON.parse(new TextDecoder().decode(payload));
			else {
				assert.equal(args[0], IPC_KIND.Binary);
				const length = new DataView(payload.buffer, payload.byteOffset).getUint32(0);
				request = JSON.parse(new TextDecoder().decode(payload.subarray(4, 4 + length)));
				chunks.push([...payload.subarray(4 + length)]);
			}
			if (request.method !== 'never-replies') queueMicrotask(() => host.__LIBERSHARE_IPC_RECEIVE__?.({ session: 7, sequence: ++sequence, type: 'message', data: JSON.stringify({ id: request.id, result: request.method === 'upload.end' ? request.params['uploadID'] : true }) }));
		}
		return undefined as T;
	},
};
await import('../../src/scripts/api.ts');
const { wsClient, connected, apiURL, backendConnectionStatus, setBackendToken, uploadImportFile } = await import('../../src/scripts/ws-client.ts');
const { get } = await import('svelte/store');
for (let i = 0; i < 80 && !get(connected); i++) await new Promise(resolve => setTimeout(resolve, 50));
assert.equal(get(connected), true);
assert.equal(openAttempts, 2);
assert.equal(apiURL, 'ipc://backend');
const { detectLocalFilesystem, localFilesystem } = await import('../../src/scripts/localFilesystem.ts');
await detectLocalFilesystem();
assert.equal(get(localFilesystem), true);
setBackendToken('ignored-native-token');
assert.equal(await wsClient.call('settings.list'), true);
const file = new File([Uint8Array.from([1, 2, 3, 4])], 'fixture.lish');
assert.equal(typeof (await uploadImportFile(file)), 'string');
assert.deepEqual(chunks, [[1, 2, 3, 4]]);
let progress = 0;
wsClient.on('progress', value => {
	progress = value;
});
host.__LIBERSHARE_IPC_RECEIVE__!({ session: 7, sequence: ++sequence, type: 'message', data: JSON.stringify({ event: 'progress', data: 25 }) });
assert.equal(progress, 25);
const waiting = wsClient.call('never-replies').catch(error => error);
await new Promise(resolve => setTimeout(resolve, 0));
host.__LIBERSHARE_IPC_RECEIVE__!({ session: 7, sequence: 0, type: 'closed' } satisfies NativeFrame);
assert((await waiting) instanceof Error);
assert.equal(get(backendConnectionStatus), 'disconnected');
wsClient.destroy();
assert.equal(httpCalls, 0);
assert.equal(websocketCalls, 0);
console.log('native bootstrap, upload and disconnect passed');
