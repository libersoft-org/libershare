import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Mutex } from 'async-mutex';
import { APIServer } from '../../../src/api/api.ts';
import type { APIClient } from '../../../src/api/client.ts';
import './ipc-no-http.ts';

const directory = process.env['LISH_IPC_IMPORT_GATE_DIR'];
if (!directory) throw new Error('The IPC import gate needs its isolated control directory');
const mark = (name: string, data: unknown = true): void => writeFileSync(join(directory, name), JSON.stringify(data));

interface GatedAPI {
	importLock: Mutex;
	acceptedRequests: Set<Promise<void>>;
	prepareIPC(): void;
	handleMessage(client: APIClient, message: string | Buffer): Promise<void>;
	stop(): Promise<void>;
}

const prototype = APIServer.prototype as unknown as GatedAPI;
const prepare = prototype.prepareIPC;
let held = false;
prototype.prepareIPC = function (): void {
	if (!held) {
		held = true;
		void this.importLock.acquire().then(release => {
			mark('held');
			let outputFailed = false;
			const timer = setInterval(() => {
				if (!outputFailed && existsSync(join(directory, 'fail-output'))) {
					outputFailed = true;
					process.stdout.emit('error', new Error('Injected output failure during IPC drain'));
					mark('output-failed');
				}
				if (!existsSync(join(directory, 'release'))) return;
				clearInterval(timer);
				release();
				mark('released');
			}, 10);
			timer.unref();
		});
	}
	prepare.call(this);
};

const handle = prototype.handleMessage;
prototype.handleMessage = function (client, message): Promise<void> {
	const running = handle.call(this, client, message);
	if (typeof message === 'string') {
		try {
			const request = JSON.parse(message);
			if (request.method === 'lishs.importFromJSON') {
				mark('accepted', { id: request.id, requests: this.acceptedRequests.size, lockHeld: this.importLock.isLocked() });
				void running.then(
					() => mark('settled'),
					() => mark('settled')
				);
			}
		} catch {
			/* Only the real dispatcher decides how to reject malformed requests. */
		}
	}
	return running;
};

const stop = prototype.stop;
prototype.stop = function (): Promise<void> {
	const stopping = stop.call(this);
	mark('stopping');
	return stopping;
};

await import('../../../src/app.ts');
