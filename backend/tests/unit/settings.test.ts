import { describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Settings } from '../../src/settings.ts';

function tempDir(name: string): string {
	const dir = join(tmpdir(), `settings-test-${name}-${process.pid}-${Date.now()}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe('settings program mode', () => {
	it('defaults to the application build on a fresh data directory', async () => {
		const dir = tempDir('default');
		try {
			const settings = await Settings.create(dir);
			expect(settings.get('system.programMode')).toBe('app');
			// The default must reach disk too, otherwise a fresh install has no stored mode.
			const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
			expect(onDisk.system.programMode).toBe('app');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('fills the mode into an older settings file without dropping stored values', async () => {
		const dir = tempDir('upgrade');
		try {
			writeFileSync(join(dir, 'settings.json'), JSON.stringify({ system: { autoStartOnBoot: false } }), 'utf8');
			const settings = await Settings.create(dir);
			expect(settings.get('system.programMode')).toBe('app');
			expect(settings.get('system.autoStartOnBoot')).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('persists a chosen mode so it survives a restart', async () => {
		const dir = tempDir('persist');
		try {
			const settings = await Settings.create(dir);
			await settings.set('system.programMode', 'system');
			const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
			expect(onDisk.system.programMode).toBe('system');
			// The stored value must win over the default on the next start.
			const reloaded = await Settings.create(dir);
			expect(reloaded.get('system.programMode')).toBe('system');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
