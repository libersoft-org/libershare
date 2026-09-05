import { describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { C_LOCALE_ENV } from '../../src/system-network-linux.ts';

const execFileAsync = promisify(execFile);

/**
 * The Linux reader matches literal English tokens — `running`, `unmanaged`,
 * `Not connected.` — and nmcli translates its output on a localised host. Every
 * child process therefore runs under the C locale, which nmcli's documentation
 * recommends for exactly this reason. Without it the failure is silent and
 * wrong rather than loud: a writable host reports itself read-only.
 */
describe('C_LOCALE_ENV', () => {
	it('pins both locale variables to C', () => {
		const env = C_LOCALE_ENV;
		expect(env['LC_ALL']).toBe('C');
		expect(env['LANG']).toBe('C');
	});

	it('keeps the rest of the environment, so the binaries stay findable', () => {
		// The candidate lists include a bare `ip` / `nmcli`, resolved through PATH.
		const env = C_LOCALE_ENV;
		const path = process.env['PATH'] ?? process.env['Path'];
		if (path) expect(env['PATH'] ?? env['Path']).toBe(path);
	});

	it('overrides a locale the parent process was started with', () => {
		const previous = process.env['LC_ALL'];
		process.env['LC_ALL'] = 'cs_CZ.UTF-8';
		try {
			expect(C_LOCALE_ENV['LC_ALL']).toBe('C');
		} finally {
			if (previous === undefined) delete process.env['LC_ALL'];
			else process.env['LC_ALL'] = previous;
		}
	});

	it('actually reaches a spawned child', async () => {
		// The env object is only useful if it is handed to the process; this runs a
		// real child under it and reads the value back out.
		const { stdout } = await execFileAsync(process.execPath, ['-e', 'console.log(process.env.LC_ALL + "|" + process.env.LANG)'], { env: C_LOCALE_ENV, timeout: 15000 });
		expect(stdout.trim()).toBe('C|C');
	});
});
