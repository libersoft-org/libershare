import { expect, test } from 'bun:test';
import { join } from 'node:path';

for (const scenario of ['expired', 'verification', 'request-file', 'valid', 'legacy']) {
	test(`Windows launcher respects the time request deadline: ${scenario}`, async () => {
		const script = String.raw`
			import { mock } from 'bun:test';
			const os = await import('node:os');
			let now = 100;
			let verifications = 0, writes = 0, prompts = 0, releases = 0;
			let timeoutMs;
			const scenario = ${JSON.stringify(scenario)};
			mock.module('node:os', () => ({ ...os, uptime: () => now }));
			const { systemTimeExitCode, parseSystemTimeExitCode } = await import('./src/system-time-helper.ts');
			globalThis.LISH_NETWORK_HELPER_SHA256 = 'a'.repeat(64);
			mock.module('./src/network-helper-windows.ts', () => ({
				WINDOWS_ELEVATION_WAIT_MS: 120000, WINDOWS_NETWORK_ELEVATION_WAIT_MS: 180000,
				WINDOWS_LAUNCHER_EXIT: { untrusted: 3, cancelled: 4, denied: 5, timeout: 6 },
				verifyWindowsInstalledHelper: async (_helper, _backend, _hash, options) => {
					verifications++; timeoutMs = options?.timeoutMs;
					if (scenario === 'verification') now = 102;
					return true;
				},
				windowsLocalAppDataPath: () => 'test-appdata',
				windowsRequestFileName: () => 'request.json',
				windowsCurrentProcessIdentity: () => ({ pid: 1, created: '1' }),
				writeWindowsRequestFile: () => {
					writes++;
					if (scenario === 'request-file') now = 102;
					return { path: 'request.json', release: () => releases++ };
				},
				windowsHelperParameters: path => path,
				runElevatedWindowsProcess: async () => {
					prompts++;
					return { kind: 'exited', code: systemTimeExitCode({ success: true, outcome: 'ok', message: null }) };
				},
			}));
			const { encodeNetworkHelperRequest } = await import('./src/network-helper-protocol.ts');
			const request = { version: 1, operation: 'applySystemTime', changes: { ntpEnabled: false },
				...(scenario === 'legacy' ? {} : { deadlineUptime: scenario === 'expired' ? 99 : 101 }) };
			process.argv = [process.execPath, 'launcher', '--request', encodeNetworkHelperRequest(request)];
			await import('./src/network-helper-windows-launcher.ts');
			const result = parseSystemTimeExitCode(Number(process.exitCode ?? 0));
			process.exitCode = 0;
			console.log(JSON.stringify({ result, verifications, writes, prompts, releases, timeoutMs }));
		`;
		const child = Bun.spawn([process.execPath, '--eval', script], { cwd: join(import.meta.dir, '../..'), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
		const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		if (code !== 0) throw new Error(err);
		const proof = JSON.parse(out.trim());
		const expired = !['valid', 'legacy'].includes(scenario);
		expect(proof.result.outcome).toBe(expired ? 'error' : 'ok');
		expect(proof.result.stateMayHaveChanged).toBeUndefined();
		expect(proof.verifications).toBe(scenario === 'expired' ? 0 : 1);
		expect(proof.prompts).toBe(expired ? 0 : 1);
		expect(proof.writes).toBe(['expired', 'verification'].includes(scenario) ? 0 : 1);
		expect(proof.releases).toBe(proof.writes);
		if (scenario !== 'expired' && scenario !== 'legacy') expect(proof.timeoutMs).toBe(1000);
	});
}
