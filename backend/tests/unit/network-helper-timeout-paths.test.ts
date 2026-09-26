import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { HelperVerificationTimeoutError } from '../../src/network-helper-integrity.ts';
import { runElevatedSystemTime } from '../../src/network-helper-client.ts';
import { withSaveBudget } from '../../src/system-time-common.ts';

/**
 * A time save whose helper could not be verified in time stops before anything elevated is
 * started: it answers `error` with neither change flag, so the screen does not claim the host
 * may have changed. A trust check that simply outlives the save ends only that save's wait.
 */

const changes = { ntpEnabled: false } as const;
const timesOut = async (): Promise<boolean> => {
	throw new HelperVerificationTimeoutError();
};
const never = (): Promise<boolean> => new Promise<boolean>(() => {});

describe('elevated time save before launch', () => {
	for (const platform of ['linux', 'darwin', 'win32'] as const) {
		it(`answers error without change flags when verification times out on ${platform}`, async () => {
			const result = await runElevatedSystemTime(changes, platform, () => 1000, timesOut);
			expect(result.outcome).toBe('error');
			expect(result.changed).toBeUndefined();
			expect(result.stateMayHaveChanged).toBeUndefined();
		});
	}

	it('ends a save whose budget runs out while the shared check is still running', async () => {
		let clock = 0;
		const started = performance.now();
		const result = await withSaveBudget(
			() => runElevatedSystemTime(changes, 'linux', () => 1000, never),
			() => clock,
			50
		);
		clock = 1_000;
		expect(result.outcome).toBe('error');
		expect(result.stateMayHaveChanged).toBeUndefined();
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it('refuses to launch with no budget left after the check passed', async () => {
		let clock = 0;
		const passesLate = async (): Promise<boolean> => {
			clock = 1_000;
			return true;
		};
		const result = await withSaveBudget(
			() => runElevatedSystemTime(changes, 'linux', () => 1000, passesLate),
			() => clock,
			50
		);
		expect(result).toMatchObject({ outcome: 'error' });
		expect(result.stateMayHaveChanged).toBeUndefined();
	});

	it('keeps an untrusted helper as permission-denied', async () => {
		expect(
			(
				await runElevatedSystemTime(
					changes,
					'linux',
					() => 1000,
					async () => false
				)
			).outcome
		).toBe('permission-denied');
	});
});

describe('windows trust budget', () => {
	it('counts reading the files into the budget instead of starting it afterwards', async () => {
		const { verifyWindowsHelper } = await import('../../src/network-helper-client.ts');
		// The first reading starts the budget; every later one is past it, as after a stuck stat.
		let calls = 0;
		const clock = (): number => (calls++ === 0 ? 0 : 31_000);
		await expect(verifyWindowsHelper('C:/no-such-dir/lish-network-helper.exe', clock)).rejects.toBeInstanceOf(HelperVerificationTimeoutError);
	});
});

describe('macOS save whose helper preparation outlives the budget', () => {
	it('never opens the authorization prompt', async () => {
		// In a child process: the module mock replaces child_process for everything it loads.
		const script = `
			import { mock } from 'bun:test';
			const cp = { ...(await import('node:child_process')) };
			const calls = [];
			const execFile = (file, args, options, callback) => {
				const done = typeof options === 'function' ? options : callback;
				calls.push(file);
				// codesign answers slowly, past the save budget; osascript would be the prompt.
				setTimeout(() => done(null, { stdout: '', stderr: 'TeamIdentifier=TEAMID' + String.fromCharCode(10) + 'Identifier=app.example' }), file.endsWith('codesign') ? 400 : 0);
			};
			mock.module('node:child_process', () => ({ ...cp, execFile }));
			const { writeFileSync, mkdtempSync } = await import('node:fs');
			const { join } = await import('node:path');
			const { tmpdir } = await import('node:os');
			// The helper sits next to the running binary; point that binary into a scratch folder.
			const dir = mkdtempSync(join(tmpdir(), 'lish-mac-helper-'));
			process.execPath = join(dir, 'lish-backend');
			writeFileSync(join(dir, 'lish-network-helper'), 'helper');
			const { runElevatedSystemTime } = await import('./src/network-helper-client.ts');
			const { withSaveBudget } = await import('./src/system-time-common.ts');
			const result = await withSaveBudget(() => runElevatedSystemTime({ ntpEnabled: false }, 'darwin', () => 1000, async () => true), () => Date.now(), 150);
			await new Promise(resolve => setTimeout(resolve, 700));
			console.log(JSON.stringify({ outcome: result.outcome, prompted: calls.some(file => file.endsWith('osascript')) }));
		`;
		const child = Bun.spawn([process.execPath, '--eval', script], { cwd: join(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' });
		const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		if (code !== 0) throw new Error(`fixture exited ${code}: ${err}`);
		const lines = out.trim().split(String.fromCharCode(10));
		const result = JSON.parse(lines[lines.length - 1]!);
		expect(result.outcome).toBe('error');
		expect(result.prompted).toBe(false);
	}, 30_000);
});
