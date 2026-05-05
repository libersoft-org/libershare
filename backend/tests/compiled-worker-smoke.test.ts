import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, type Subprocess } from 'bun';

async function findFreePort(): Promise<number> {
	const server = Bun.serve({
		port: 0,
		fetch: () => new Response('ok'),
	});
	const port = server.port;
	server.stop(true);
	if (port === undefined) throw new Error('failed to allocate a free port');
	return port;
}

async function waitForBackend(port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const ws = new WebSocket(`ws://localhost:${port}/ws`);
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					ws.close();
					reject(new Error('websocket open timeout'));
				}, 500);
				ws.addEventListener('open', () => {
					clearTimeout(timer);
					ws.close();
					resolve();
				});
				ws.addEventListener('error', error => {
					clearTimeout(timer);
					reject(error);
				});
			});
			return;
		} catch (error) {
			lastError = error;
			await Bun.sleep(250);
		}
	}
	throw new Error(`backend did not open ws://localhost:${port}/ws: ${String(lastError)}`);
}

function rpc(ws: WebSocket, method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
	const id = crypto.randomUUID();
	ws.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			ws.removeEventListener('message', onMessage);
			reject(new Error(`RPC timeout: ${method}`));
		}, timeoutMs);
		function onMessage(event: MessageEvent): void {
			const msg = JSON.parse(event.data as string);
			if (msg.id !== id) return;
			clearTimeout(timer);
			ws.removeEventListener('message', onMessage);
			if (msg.error) reject(new Error(`${method}: ${msg.error}${msg.errorDetail ? `: ${msg.errorDetail}` : ''}`));
			else resolve(msg.result);
		}
		ws.addEventListener('message', onMessage);
	});
}

async function openWs(port: number): Promise<WebSocket> {
	const ws = new WebSocket(`ws://localhost:${port}/ws`);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('websocket open timeout')), 5_000);
		ws.addEventListener('open', () => {
			clearTimeout(timer);
			resolve();
		});
		ws.addEventListener('error', error => {
			clearTimeout(timer);
			reject(error);
		});
	});
	return ws;
}

async function stopProcess(proc: Subprocess<'ignore', 'pipe', 'pipe'>): Promise<void> {
	try {
		proc.kill();
		await Promise.race([proc.exited, Bun.sleep(5_000)]);
	} catch {}
}

interface CompiledBackend {
	tempRoot: string;
	sourceDir: string;
	outputDir: string;
	exePath: string;
	apiPort: number;
	backend: Subprocess<'ignore', 'pipe', 'pipe'>;
}

async function buildAndSpawnCompiledBackend(prefix: string): Promise<CompiledBackend> {
	const tempRoot = await mkdtemp(join(tmpdir(), `libershare-${prefix}-`));
	const sourceDir = join(tempRoot, 'source');
	const outputDir = join(tempRoot, 'out');
	const dataDir = join(tempRoot, 'data');
	const buildDir = join(tempRoot, 'build');
	const runDir = join(tempRoot, 'run');
	const exePath = join(buildDir, process.platform === 'win32' ? 'lish-backend.exe' : 'lish-backend');

	await mkdir(sourceDir, { recursive: true });
	await mkdir(outputDir, { recursive: true });
	await mkdir(dataDir, { recursive: true });
	await mkdir(buildDir, { recursive: true });
	await mkdir(join(buildDir, 'lish'), { recursive: true });
	await mkdir(runDir, { recursive: true });
	await writeFile(
		join(dataDir, 'settings.json'),
		JSON.stringify({
			network: {
				incomingPort: 0,
				allowRelay: false,
				maxRelayClients: 0,
				mdnsEnabled: false,
			},
		})
	);

	const build = spawn({
		cmd: ['bun', 'build', '--compile', './src/app.ts', '--outfile', exePath],
		cwd: import.meta.dir + '/..',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const buildExit = await build.exited;
	const buildOutput = `${await new Response(build.stdout).text()}${await new Response(build.stderr).text()}`;
	expect(buildExit, buildOutput).toBe(0);

	const workerBuild = spawn({
		cmd: ['bun', 'build', './src/lish/checksum-worker.ts', '--target', 'bun', '--outfile', join(buildDir, 'lish', 'checksum-worker.js')],
		cwd: import.meta.dir + '/..',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const workerBuildExit = await workerBuild.exited;
	const workerBuildOutput = `${await new Response(workerBuild.stdout).text()}${await new Response(workerBuild.stderr).text()}`;
	expect(workerBuildExit, workerBuildOutput).toBe(0);

	const apiPort = await findFreePort();
	const backend = spawn({
		cmd: [exePath, '--datadir', dataDir, '--host', 'localhost', '--port', String(apiPort), '--loglevel', 'debug'],
		cwd: runDir,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	await waitForBackend(apiPort, 20_000);

	return { tempRoot, sourceDir, outputDir, exePath, apiPort, backend };
}

async function teardownCompiledBackend(ctx: CompiledBackend | undefined): Promise<void> {
	if (!ctx) return;
	await stopProcess(ctx.backend);
	await rm(ctx.tempRoot, { recursive: true, force: true });
}

test(
	'compiled backend can create a LISH with the default checksum settings outside the source tree',
	async () => {
		let ctx: CompiledBackend | undefined;
		try {
			ctx = await buildAndSpawnCompiledBackend('compiled-worker-smoke');
			await writeFile(join(ctx.sourceDir, 'a.txt'), 'a'.repeat(10_000));
			await writeFile(join(ctx.sourceDir, 'b.txt'), 'b'.repeat(10_000));

			const ws = await openWs(ctx.apiPort);
			const progressEvents: string[] = [];
			ws.addEventListener('message', event => {
				const msg = JSON.parse(event.data as string);
				if (msg.event === 'lishs.create:progress') progressEvents.push(msg.data.type);
			});

			await rpc(ws, 'events.subscribe', { events: ['lishs.create:progress'] });
			const result = await rpc(
				ws,
				'lishs.create',
				{
					dataPath: ctx.sourceDir,
					lishFile: join(ctx.outputDir, 'compiled-worker-smoke.lish'),
					addToSharing: false,
					addToDownloading: false,
					name: 'Compiled worker smoke',
					chunkSize: 1024,
					minifyJSON: false,
					compress: false,
				},
				30_000
			);
			ws.close();

			expect(result).toHaveProperty('lishID');
			expect(progressEvents).toContain('chunk');
			expect(progressEvents.filter(type => type === 'file')).toHaveLength(2);
		} finally {
			await teardownCompiledBackend(ctx);
		}
	},
	120_000
);

// Regression guard for the Windows compiled `worker.terminate()` segfault path. The fix in
// lish.ts swaps terminate() for unref() on busy workers when running as a compiled binary on
// Windows. We prove the abort cleanup no longer crashes by mid-flight cancelling a multi-file
// LISH creation and verifying the backend stays responsive afterwards.
test(
	'compiled backend handles stopCreate mid-flight without crashing',
	async () => {
		let ctx: CompiledBackend | undefined;
		try {
			ctx = await buildAndSpawnCompiledBackend('compiled-worker-stop');
			// 3 × 8 MB random files keep workers busy long enough to abort during chunk hashing
			// without finishing the run instantly.
			const fileBytes = 8 * 1024 * 1024;
			for (const name of ['a.bin', 'b.bin', 'c.bin']) {
				const buf = new Uint8Array(fileBytes);
				crypto.getRandomValues(buf.subarray(0, 65_536));
				await writeFile(join(ctx.sourceDir, name), buf);
			}

			const ws = await openWs(ctx.apiPort);
			let progressCount = 0;
			ws.addEventListener('message', event => {
				const msg = JSON.parse(event.data as string);
				if (msg.event === 'lishs.create:progress') progressCount++;
			});
			await rpc(ws, 'events.subscribe', { events: ['lishs.create:progress'] });

			const createPromise = rpc(
				ws,
				'lishs.create',
				{
					dataPath: ctx.sourceDir,
					lishFile: join(ctx.outputDir, 'stop-create.lish'),
					addToSharing: false,
					addToDownloading: false,
					name: 'Stop create regression',
					chunkSize: 65_536,
					minifyJSON: false,
					compress: false,
				},
				60_000
			);

			// Wait until at least one chunk has progressed so we know workers are active.
			const startWait = Date.now();
			while (progressCount === 0 && Date.now() - startWait < 30_000) await Bun.sleep(50);
			expect(progressCount).toBeGreaterThan(0);

			await rpc(ws, 'lishs.stopCreate', {});

			let createError: unknown;
			try {
				await createPromise;
			} catch (e) {
				createError = e;
			}
			expect(String(createError)).toContain('LISH_CREATE_CANCELLED');

			// Backend must still be alive: a follow-up RPC should succeed.
			expect(ctx.backend.exitCode).toBeNull();
			const list = await rpc(ws, 'lishs.list', {});
			expect(list).toBeDefined();

			ws.close();
		} finally {
			await teardownCompiledBackend(ctx);
		}
	},
	180_000
);
