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

function scratch(failIn: string | null): { root: string; env: Record<string, string> } {
	const root = mkdtempSync(join(tmpdir(), 'lish-gates-'));
	dirs.push(root);
	for (const s of SCRIPTS) {
		copyFileSync(join(REPO, s), join(root, s));
		chmodSync(join(root, s), 0o755);
	}
	for (const pkg of ['backend', 'frontend', 'shared', 'cli']) mkdirSync(join(root, pkg));
	const bin = join(root, 'stub-bin');
	mkdirSync(bin);
	// Records every call and fails inside the chosen package directory.
	writeFileSync(join(bin, 'bun'), `#!/bin/sh\necho "$(basename "$PWD") $*" >> "${root.split(String.fromCharCode(92)).join('/')}/calls.log"\n[ "$(basename "$PWD")" = "${failIn ?? '-'}" ] && exit 3\nexit 0\n`);
	chmodSync(join(bin, 'bun'), 0o755);
	return { root, env: { ...process.env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env['PATH']}` } as Record<string, string> };
}

function run(root: string, script: string, env: Record<string, string>): number {
	return Bun.spawnSync(['sh', join(root, script)], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' }).exitCode;
}

describe('shell gates propagate failures', () => {
	for (const [script, pkg] of [
		['test-be.sh', 'backend'],
		['test-shared.sh', 'shared'],
		['test-cli.sh', 'cli'],
		['test-fe.sh', 'frontend'],
	] as const) {
		it(`${script} fails when its gate fails`, () => {
			const { root, env } = scratch(pkg);
			expect(run(root, script, env)).not.toBe(0);
		});
	}

	it('test-all.sh fails on a failing middle gate and does not run the later ones', () => {
		const { root, env } = scratch('shared');
		expect(run(root, 'test-all.sh', env)).not.toBe(0);
		const calls = require('node:fs').readFileSync(join(root, 'calls.log'), 'utf8');
		expect(calls).not.toContain('cli ');
	});

	it('test-all.sh passes when every gate passes, from any working directory', () => {
		const { root, env } = scratch(null);
		expect(Bun.spawnSync(['sh', join(root, 'test-all.sh')], { cwd: tmpdir(), env, stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0);
	});
});
