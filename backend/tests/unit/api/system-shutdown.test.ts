import { expect, it } from 'bun:test';
import { resolve } from 'node:path';

it('a startup volume read that finishes after stopPolling does not save the volume', async () => {
	const script = `
		import { mock } from 'bun:test';
		const volume = await import('./src/system-volume.ts');
		let release;
		const held = new Promise(r => (release = r));
		mock.module('./src/system-volume.ts', () => ({ ...volume, getSystemVolumeStatus: async () => { await held; return { available: true, volume: 42, muted: false }; } }));
		const saves = [];
		const { initSystemHandlers } = await import('./src/api/system.ts');
		const handlers = initSystemHandlers({ get: () => '', set: async (path, value) => { saves.push([path, value]); } }, () => {}, () => false, true);
		handlers.stopPolling();
		release();
		for (let i = 0; i < 5; i++) await new Promise(setImmediate);
		console.log(JSON.stringify({ saves }));
	`;
	const child = Bun.spawn([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe' });
	const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		if (exitCode !== 0) throw new Error(`fixture exited ${exitCode}: ${stderr}`);
		const line = stdout.trim().split('\n').at(-1)!;
		expect(JSON.parse(line)).toEqual({ saves: [] });
	} finally {
		clearTimeout(deadline);
	}
});
