import { describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WINDOWS_ALIAS_GUARD } from '../../src/system-network-windows.ts';

const execFileAsync = promisify(execFile);

/**
 * Behavioural coverage for the PowerShell fragments the Windows apply is built
 * from.
 *
 * The rest of the Windows suite asserts the TEXT of the composed one-shot, which
 * proves the script says what the author meant and nothing about what PowerShell
 * then does with it. These cases run the fragments for real against scripted
 * state — an `$oldAddresses` array of the shape the snapshot produces, a
 * `Get-NetIPAddress` replaced by a function that answers a chosen sequence — so a
 * guard that parses but does not fire is a failure here rather than a passing
 * `toContain`.
 *
 * Windows only: the fragments are PowerShell, and there is nothing to run them
 * with elsewhere. Nothing here mutates the host — no cmdlet that changes state is
 * ever reached, because every one of them is shadowed by a local function.
 */
describe.skipIf(process.platform !== 'win32')('windows apply fragments (live PowerShell)', () => {
	/** Run a fragment, answering with the exit code and whatever it wrote to stderr. */
	async function run(script: string): Promise<{ failed: boolean; stderr: string }> {
		try {
			await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
			return { failed: false, stderr: '' };
		} catch (err) {
			return { failed: true, stderr: String((err as { stderr?: string }).stderr ?? (err as Error).message) };
		}
	}

	/** One `$oldAddresses` row, in the shape {@link windowsSnapshotSteps} selects. */
	function addresses(...rows: Array<{ ip: string; origin?: string }>): string {
		const objects = rows.map(row => `[pscustomobject]@{ IPAddress='${row.ip}'; PrefixLength=24; PrefixOrigin='${row.origin ?? 'Manual'}'; SuffixOrigin='${row.origin ?? 'Manual'}' }`);
		return `$oldAddresses = @(${objects.join(', ')})`;
	}

	describe('the alias guard', () => {
		it('lets a single address through', async () => {
			expect(await run(`${addresses({ ip: '192.0.2.10' })}; ${WINDOWS_ALIAS_GUARD}`)).toEqual({ failed: false, stderr: '' });
		});

		it('lets an interface with no address at all through', async () => {
			expect((await run(`$oldAddresses = @(); ${WINDOWS_ALIAS_GUARD}`)).failed).toBe(false);
		});

		// The case the prefix exemption used to miss. Both of these are real addresses
		// on the interface, the removal takes both, and the second one is one the user
		// configured by hand — `PrefixOrigin` says so, the text `169.254.` does not.
		it('refuses a routable address beside a manually configured link-local one', async () => {
			const result = await run(`${addresses({ ip: '192.0.2.10' }, { ip: '169.254.10.20', origin: 'Manual' })}; ${WINDOWS_ALIAS_GUARD}`);
			expect(result.failed).toBe(true);
			expect(result.stderr).toContain('several IPv4 addresses');
		});

		it('refuses an automatic APIPA address beside a routable one just the same', async () => {
			// Not because it is worth preserving, but because the guard cannot tell it
			// from the manual one above and must not delete either on a guess.
			const result = await run(`${addresses({ ip: '192.0.2.10' }, { ip: '169.254.10.20', origin: 'WellKnown' })}; ${WINDOWS_ALIAS_GUARD}`);
			expect(result.failed).toBe(true);
			expect(result.stderr).toContain('several IPv4 addresses');
		});
	});
});
