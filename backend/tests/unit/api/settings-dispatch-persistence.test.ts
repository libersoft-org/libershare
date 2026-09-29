import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const fault of ['rename', 'dirsync']) {
	for (const method of ['set', 'applyImported', 'reset']) {
		test(`${method} serializes a ${fault} failure and preserves the reported disk state`, async () => {
			const dir = await mkdtemp(join(tmpdir(), 'lish-dispatch-persistence-'));
			const script = `
				import { mock } from 'bun:test';
				const fsp = { ...(await import('node:fs/promises')) };
				const { resolve } = await import('node:path');
				const dir = resolve(${JSON.stringify(dir)});
				let armed = false;
				const eio = () => Object.assign(new Error('injected'), { code: 'EIO' });
				mock.module('node:fs/promises', () => ({
					...fsp,
					rename: async (...args) => {
						if (armed && ${JSON.stringify(fault)} === 'rename') throw eio();
						return fsp.rename(...args);
					},
					open: async (path, flags, mode) => {
						const handle = await fsp.open(path, flags, mode);
						if (armed && ${JSON.stringify(fault)} === 'dirsync' && resolve(String(path)) === dir)
							return { sync: async () => { throw eio(); }, close: () => handle.close() };
						return handle;
					},
				}));
				const { Settings } = await import('./src/settings.ts');
				const { initSettingsHandlers } = await import('./src/api/settings.ts');
				const { APIServer } = await import('./src/api/api.ts');
				const settings = await Settings.create(dir);
				await settings.set('audio.volume', 17);
				const previous = JSON.parse(await fsp.readFile(dir + '/settings.json', 'utf8'));
				const handlers = initSettingsHandlers(settings);
				const server = Object.create(APIServer.prototype);
				Object.assign(server, {
					accepting: true, acceptedRequests: new Set(),
					handlers: Object.fromEntries(Object.entries(handlers).map(([name, fn]) => ['settings.' + name, fn])),
				});
				const sent = [];
				armed = true;
				const method = ${JSON.stringify(method)};
				const params = method === 'set' ? { path: 'audio.volume', value: 9 }
					: method === 'applyImported' ? { data: { audio: { volume: 9 } } } : {};
				await server.handleMessage({ send: raw => sent.push(JSON.parse(raw)) }, JSON.stringify({ id: 1, method: 'settings.' + method, params }));
				console.log(JSON.stringify({ sent, previous, expectedVolume: method === 'reset' ? settings.getDefaults().audio.volume : 9 }));
			`;
			try {
				const child = Bun.spawn([process.execPath, '--eval', script], { cwd: join(import.meta.dir, '../../..'), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
				const timeout = setTimeout(() => child.kill(), 15_000);
				let out: string;
				try {
					const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
					if (code !== 0) throw new Error(`fixture exited ${code}: ${stderr}`);
					out = stdout;
				} finally {
					clearTimeout(timeout);
				}
				const lines = out.trim().split('\n');
				const result = JSON.parse(lines[lines.length - 1]!);
				const detail = fault === 'rename' ? 'Settings file was not replaced; in-memory settings may differ from disk (EIO).' : 'Settings file now contains the new settings, but durability could not be confirmed (EIO).';
				expect(result.sent).toEqual([{ id: 1, error: 'INTERNAL_ERROR', errorDetail: detail }]);
				const content = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
				if (fault === 'rename') expect(content).toEqual(result.previous);
				else expect(content.audio.volume).toBe(result.expectedVolume);
				expect(await readdir(dir)).toEqual(['settings.json']);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}, 20_000);
	}
}
