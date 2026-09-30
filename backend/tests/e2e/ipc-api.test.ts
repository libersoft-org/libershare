import { expect, it } from 'bun:test';
import type { FileSink } from 'bun';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { productEnvPrefix } from '@shared';
import { IPC_KIND, IPC_VERSION, IpcFrameDecoder, type IpcFrame, type IpcKind } from '@shared/ipc-frame.ts';

const ROOT = resolve(import.meta.dir, '../../..');

// Encode independently of the shared writer so the process boundary is exercised too.
function frame(kind: number, session: number, payload = Buffer.alloc(0)): Buffer {
	const bytes = Buffer.alloc(9 + payload.length);
	bytes.writeUInt32BE(5 + payload.length, 0);
	bytes[4] = kind;
	bytes.writeUInt32BE(session, 5);
	payload.copy(bytes, 9);
	return bytes;
}

class IPCProcess {
	readonly root = mkdtempSync(join(tmpdir(), 'lish-ipc-'));
	readonly data = join(this.root, 'data');
	readonly frames: IpcFrame[] = [];
	readonly proc: ReturnType<typeof Bun.spawn>;
	readonly drains: Promise<void>[];
	log = '';
	readError: unknown;
	private nextID = 0;

	constructor() {
		mkdirSync(this.data);
		const storage: Record<string, string> = {};
		for (const key of ['downloadPath', 'tempPath', 'lishPath', 'lishnetPath', 'backupPath']) {
			storage[key] = join(this.root, key);
			mkdirSync(storage[key]!);
		}
		writeFileSync(join(this.data, 'settings.json'), JSON.stringify({ storage, network: { incomingPort: 0, mdnsEnabled: false, upnpEnabled: false, allowRelay: false, useRelayClients: false, autoConnectNewNetworks: false, peerExchange: { enabled: false } } }));
		const env: Record<string, string> = { HOME: this.root, USERPROFILE: this.root, STORAGE_ROOT: this.root, TMP: this.root, TEMP: this.root, TMPDIR: this.root, MEMTRACE: '0', HEAP_TRIGGER: '0' };
		for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key]!;
		for (const key of ['DOWNLOAD', 'TEMP', 'LISH', 'LISHNET', 'BACKUP']) env[`${productEnvPrefix}_${key}_PATH`] = join(this.root, key);
		const proc = Bun.spawn([process.execPath, '--preload', './backend/tests/e2e/helpers/ipc-no-http.ts', './backend/src/app.ts', '--ipc', '--datadir', this.data], { cwd: ROOT, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
		this.proc = proc;
		const decoder = new IpcFrameDecoder();
		this.drains = [
			(async () => {
				try {
					for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) this.frames.push(...decoder.push(chunk));
					decoder.finish();
				} catch (error) {
					this.readError = error;
				}
			})(),
			(async () => {
				for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) this.log += new TextDecoder().decode(chunk);
			})(),
		];
	}

	async until<T>(read: () => T | undefined, timeout = 15_000): Promise<T> {
		const end = Date.now() + timeout;
		for (;;) {
			if (this.readError) throw this.readError;
			const value = read();
			if (value !== undefined) return value;
			if (this.proc.exitCode !== null) throw new Error(`IPC process exited ${this.proc.exitCode}: ${this.log.slice(-1200)}`);
			if (Date.now() >= end) throw new Error(`IPC wait timed out: ${this.log.slice(-1200)}`);
			await Bun.sleep(10);
		}
	}

	async send(kind: IpcKind, session: number, payload = Buffer.alloc(0)): Promise<void> {
		(this.proc.stdin as FileSink).write(frame(kind, session, payload));
		await (this.proc.stdin as FileSink).flush();
	}

	async open(session: number): Promise<void> {
		await this.send(IPC_KIND.Open, session);
		await this.until(() => this.frames.find(item => item.kind === IPC_KIND.Opened && item.session === session));
	}

	async request(session: number, method: string, params: Record<string, unknown> = {}, payload?: Buffer): Promise<any> {
		const id = String(++this.nextID);
		const header = Buffer.from(JSON.stringify({ id, method, params }));
		if (payload) {
			const binary = Buffer.alloc(4 + header.length + payload.length);
			binary.writeUInt32BE(header.length);
			header.copy(binary, 4);
			payload.copy(binary, 4 + header.length);
			await this.send(IPC_KIND.Binary, session, binary);
		} else await this.send(IPC_KIND.Text, session, header);
		return this.until(() => this.messages(session).find(message => message.id === id));
	}

	messages(session: number): any[] {
		return this.frames.filter(item => item.kind === IPC_KIND.Text && item.session === session).map(item => JSON.parse(Buffer.from(item.payload).toString()));
	}
	async eof(): Promise<number> {
		(this.proc.stdin as FileSink).end();
		const timer = setTimeout(() => this.proc.kill(9), 35_000);
		try {
			const code = await this.proc.exited;
			await Promise.all(this.drains);
			return code;
		} finally {
			clearTimeout(timer);
		}
	}
	async cleanup(): Promise<void> {
		if (this.proc.exitCode === null) await this.eof();
		await Promise.all(this.drains);
		rmSync(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

it('serves RPC, events and binary uploads without a token or HTTP listener, then drains on EOF', async () => {
	const child = new IPCProcess();
	try {
		const ready = await child.until(() => child.frames.find(item => item.kind === IPC_KIND.Ready));
		expect(ready.session).toBe(0);
		expect([...ready.payload]).toEqual([IPC_VERSION]);
		await child.open(1);
		expect((await child.request(1, 'settings.list')).result.network).toBeDefined();
		await child.request(1, 'events.subscribe', { events: ['system:ram'] });
		await child.until(() => child.messages(1).find(item => item.event === 'system:ram'));
		const upload = (await child.request(1, 'upload.begin', { name: 'settings.json' })).result.uploadID;
		const bytes = Buffer.from('{"language":"cs"}');
		expect((await child.request(1, 'upload.chunk', { uploadID: upload }, bytes)).result.received).toBe(bytes.length);
		await child.request(1, 'upload.end', { uploadID: upload });
		expect((await child.request(1, 'settings.parseFromUpload', { uploadID: upload })).result).toEqual({ language: 'cs' });
		const orphan = (await child.request(1, 'upload.begin', { name: 'partial.json' })).result.uploadID;
		await child.request(1, 'upload.chunk', { uploadID: orphan }, Buffer.from('{'));
		await child.send(IPC_KIND.Close, 1);
		await child.until(() => child.frames.find(item => item.kind === IPC_KIND.Close && item.session === 1));
		await child.open(2);
		expect((await child.request(2, 'upload.end', { uploadID: orphan })).error).toBe('UPLOAD_NOT_FOUND');
		await child.until(() => (!existsSync(join(child.data, 'tmp')) || readdirSync(join(child.data, 'tmp')).length === 0 ? true : undefined));
		const framesAtClose = child.frames.filter(item => item.session === 1).length;
		await child.send(IPC_KIND.Text, 1, Buffer.from('{"id":"stale","method":"settings.set","params":{"path":"language","value":"de"}}'));
		await child.request(2, 'events.subscribe', { events: ['system:ram'] });
		await child.until(() => child.messages(2).find(item => item.event === 'system:ram'));
		expect(child.frames.filter(item => item.session === 1)).toHaveLength(framesAtClose);
		expect((await child.request(2, 'settings.get', { path: 'language' })).result).not.toBe('de');
		await child.send(IPC_KIND.Text, 2, Buffer.from('null'));
		await child.until(() => child.messages(2).find(item => item.error === 'PARSE_ERROR'));
		const abandonedAtEOF = (await child.request(2, 'upload.begin', { name: 'unfinished.json' })).result.uploadID;
		await child.request(2, 'upload.chunk', { uploadID: abandonedAtEOF }, Buffer.from('{"language":'));
		await child.send(IPC_KIND.Text, 2, Buffer.from('{"id":"last-write","method":"settings.set","params":{"path":"language","value":"cs"}}'));
		expect(await child.eof()).toBe(0);
		expect(readdirSync(join(child.data, 'tmp'))).toEqual([]);
		expect(JSON.parse(readFileSync(join(child.data, 'settings.json'), 'utf8')).language).toBe('cs');
		expect(child.log).toContain('Shutdown complete');
		expect(child.log).not.toContain('WebSocket server listening');
		expect(child.log).not.toContain('HTTP listener attempted');
		expect(child.readError).toBeUndefined();
	} finally {
		await child.cleanup();
	}
}, 60_000);

it('rejects a frame in the wrong direction without logging its payload', async () => {
	const child = new IPCProcess();
	try {
		await child.until(() => child.frames.find(item => item.kind === IPC_KIND.Ready));
		const secret = 'ipc-payload-must-not-be-logged';
		await child.send(IPC_KIND.Opened, 1, Buffer.from(secret));
		expect(await child.eof()).toBe(1);
		expect(child.log).not.toContain(secret);
		expect(child.log).toContain('Invalid frame');
		expect(child.readError).toBeUndefined();
	} finally {
		await child.cleanup();
	}
}, 45_000);

it('observes EOF before readiness without opening HTTP or forcing a second shutdown', async () => {
	const child = new IPCProcess();
	try {
		expect(await child.eof()).toBe(0);
		expect(child.log).toContain('Shutdown complete');
		expect(child.log).not.toContain('HTTP listener attempted');
		expect(child.readError).toBeUndefined();
	} finally {
		await child.cleanup();
	}
}, 45_000);
