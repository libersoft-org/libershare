import { describe, expect, it, afterAll } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The shell gates must fail when a gate fails. Each case copies the real scripts into a
 * scratch tree with a stub `bun` on PATH that fails for one package, then runs the real
 * script with `sh`.
 */
const REPO = resolve(import.meta.dir, '../../../..');
const SCRIPTS = ['test-all.sh', 'test-be.sh', 'test-fe.sh', 'test-shared.sh', 'test-cli.sh', 'fix-rights.sh'];
const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** `failOn` is one exact call, "<package directory> <bun arguments>", that exits 3. */
function scratch(failOn: string | null): { root: string; env: Record<string, string> } {
	const root = mkdtempSync(join(tmpdir(), 'lish-gates-'));
	dirs.push(root);
	for (const s of SCRIPTS) {
		copyFileSync(join(REPO, s), join(root, s));
		chmodSync(join(root, s), 0o755);
	}
	for (const pkg of ['backend', 'frontend', 'shared', 'cli']) mkdirSync(join(root, pkg));
	const bin = join(root, 'stub-bin');
	mkdirSync(bin);
	// Records every call and fails the chosen one.
	writeFileSync(join(bin, 'bun'), `#!/bin/sh\nline="$(basename "$PWD") $*"\necho "$line" >> "${root.split(String.fromCharCode(92)).join('/')}/calls.log"\n[ "$line" = "${failOn ?? '-'}" ] && exit 3\nexit 0\n`);
	chmodSync(join(bin, 'bun'), 0o755);
	return { root, env: { ...process.env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env['PATH']}` } as Record<string, string> };
}

function run(root: string, script: string, env: Record<string, string>): number {
	return Bun.spawnSync(['sh', join(root, script)], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' }).exitCode;
}

describe('shell gates propagate failures', () => {
	const readCalls = (root: string): string[] =>
		require('node:fs')
			.readFileSync(join(root, 'calls.log'), 'utf8')
			.split(String.fromCharCode(10))
			.filter((line: string) => line !== '');
	/** The calls a script makes when every gate passes. */
	const callsOf = (script: string): string[] => {
		const { root, env } = scratch(null);
		expect(run(root, script, env)).toBe(0);
		return readCalls(root);
	};
	const SCRIPTS_UNDER_TEST = ['test-be.sh', 'test-shared.sh', 'test-cli.sh', 'test-fe.sh'];

	it('test-be.sh runs typecheck, unit and e2e tests in that order', () => {
		expect(callsOf('test-be.sh')).toEqual(['backend run typecheck', 'backend run test', 'backend run test:e2e']);
	});

	it('each script fails when any one of its gates fails, and runs none after it', () => {
		for (const script of SCRIPTS_UNDER_TEST) {
			const calls = callsOf(script);
			expect(calls.length).toBeGreaterThan(0);
			for (const [index, failing] of calls.entries()) {
				const { root, env } = scratch(failing);
				expect(run(root, script, env)).not.toBe(0);
				expect(readCalls(root)).toEqual(calls.slice(0, index + 1));
			}
		}
	});

	it('test-all.sh fails on a failing middle gate and does not run the later ones', () => {
		const { root, env } = scratch(callsOf('test-shared.sh')[0]!);
		expect(run(root, 'test-all.sh', env)).not.toBe(0);
		const calls = require('node:fs').readFileSync(join(root, 'calls.log'), 'utf8');
		expect(calls).not.toContain('cli ');
	});

	it('test-all.sh passes when every gate passes, from any working directory', () => {
		const { root, env } = scratch(null);
		expect(Bun.spawnSync(['sh', join(root, 'test-all.sh')], { cwd: tmpdir(), env, stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0);
	});
});
