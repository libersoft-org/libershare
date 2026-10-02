import { expect, test } from 'bun:test';
import { join } from 'node:path';

for (const scenario of ['timeout', 'abort', 'already-aborted', 'default-limit', 'capped-limit', 'launcher']) {
	test(`Windows helper verification bounds path resolution: ${scenario}`, async () => {
		const script = String.raw`
			import { mock } from 'bun:test';
			import { getEventListeners } from 'node:events';
			import { uptime } from 'node:os';
			const fs = await import('node:fs');
			const createReadStream = fs.createReadStream;
			const promises = await import('node:fs/promises');
			const scenario = ${JSON.stringify(scenario)};
			let paths = 0, reads = 0, writes = 0;
			const pending = [];
			mock.module('node:fs/promises', () => ({ ...promises, realpath: path => {
				paths++;
				return new Promise(resolve => pending.push(() => resolve(path)));
			} }));
			mock.module('node:fs', () => ({ ...fs,
				createReadStream: (...args) => { reads++; return createReadStream(...args); },
				writeFileSync: () => { writes++; throw new Error('unexpected request file write'); },
			}));
			const controller = new AbortController();
			if (scenario === 'already-aborted') controller.abort();
			const { verifyWindowsInstalledHelper } = await import('./src/network-helper-windows.ts');
			let operation;
			const started = performance.now();
			if (scenario === 'launcher') {
				globalThis.LISH_NETWORK_HELPER_SHA256 = 'a'.repeat(64);
				const { encodeNetworkHelperRequest } = await import('./src/network-helper-protocol.ts');
				const { parseSystemTimeExitCode } = await import('./src/system-time-helper.ts');
				const request = { version: 1, operation: 'applySystemTime', changes: { ntpEnabled: false }, deadlineUptime: uptime() + 0.2 };
				process.argv = [process.execPath, 'launcher', '--request', encodeNetworkHelperRequest(request)];
				operation = import('./src/network-helper-windows-launcher.ts').then(() => {
					const result = parseSystemTimeExitCode(Number(process.exitCode ?? 0));
					process.exitCode = 0;
					return result;
				});
			} else {
				const options = { signal: controller.signal };
				if (scenario === 'timeout') options.timeoutMs = 20;
				if (scenario === 'capped-limit') options.timeoutMs = 60000;
				operation = verifyWindowsInstalledHelper('C:\\Program Files\\LiberShare\\helper.exe', 'C:\\Program Files\\LiberShare\\backend.exe', 'a'.repeat(64), options);
				if (scenario === 'abort') setTimeout(() => controller.abort(), 10);
			}
			const limit = scenario.endsWith('limit') ? 14000 : 1000;
			let guard;
			const result = await Promise.race([
				operation.catch(error => error.name),
				new Promise(resolve => { guard = setTimeout(() => resolve('still pending'), limit); }),
			]);
			clearTimeout(guard);
			const elapsedMs = performance.now() - started;
			const listeners = getEventListeners(controller.signal, 'abort').length;
			for (const resolve of pending) resolve();
			await Bun.sleep(20);
			console.log(JSON.stringify({ result, elapsedMs, paths, reads, writes, listeners }));
			process.exit(0);
		`;
		const child = Bun.spawn([process.execPath, '--eval', script], { cwd: join(import.meta.dir, '../..'), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
		const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		if (code !== 0) throw new Error(err);
		const proof = JSON.parse(out.trim());
		if (scenario === 'launcher') {
			expect(proof.result.outcome).toBe('error');
			expect(proof.result.stateMayHaveChanged).toBeUndefined();
		} else {
			expect(proof.result).toBe('HelperVerificationTimeoutError');
		}
		expect(proof.paths).toBe(scenario === 'already-aborted' ? 0 : 2);
		expect(proof.reads).toBe(0);
		expect(proof.writes).toBe(0);
		expect(proof.listeners).toBe(0);
		expect(proof.elapsedMs).toBeLessThan(scenario.endsWith('limit') ? 13000 : 800);
	}, 20000);
}
