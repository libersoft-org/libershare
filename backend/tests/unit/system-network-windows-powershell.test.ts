import { describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WINDOWS_ALIAS_GUARD, WINDOWS_ORIGIN_GUARD, WINDOWS_ROUTE_GUARD, windowsAddressingUnchanged, windowsAddressStateWait } from '../../src/system-network-windows.ts';

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

	describe('the default-route guard', () => {
		/** One `$oldRoutes` row, in the shape {@link windowsSnapshotSteps} selects. */
		function routes(...metrics: number[]): string {
			return `$oldRoutes = @(${metrics.map(metric => `[pscustomobject]@{ NextHop='192.0.2.1'; RouteMetric=${metric}; Protocol='NetMgmt'; Publish='No' }`).join(', ')})`;
		}

		it('lets a single default route through', async () => {
			expect((await run(`${routes(10)}; ${WINDOWS_ROUTE_GUARD}`)).failed).toBe(false);
		});

		it('lets an interface with no default route through', async () => {
			expect((await run(`$oldRoutes = @(); ${WINDOWS_ROUTE_GUARD}`)).failed).toBe(false);
		});

		// A backup gateway, or one a VPN client installed. The apply removes every
		// default route and creates at most one, so it used to destroy the second.
		it('refuses two default routes rather than dropping the weaker one', async () => {
			const result = await run(`${routes(10, 100)}; ${WINDOWS_ROUTE_GUARD}`);
			expect(result.failed).toBe(true);
			expect(result.stderr).toContain('several IPv4 default routes');
		});
	});

	describe('the address-provenance guard', () => {
		it('lets a hand-configured address through', async () => {
			expect((await run(`$oldDhcp = 'Disabled'; ${addresses({ ip: '192.0.2.10' })}; ${WINDOWS_ORIGIN_GUARD}`)).failed).toBe(false);
		});

		// The restore re-creates these with New-NetIPAddress, which has no parameter
		// for either origin — so an address Windows derived some other way comes back
		// as a different object and the rollback's claim to have undone the change is
		// not true.
		it('refuses a static interface holding an address it could not re-create', async () => {
			const result = await run(`$oldDhcp = 'Disabled'; ${addresses({ ip: '169.254.10.20', origin: 'WellKnown' })}; ${WINDOWS_ORIGIN_GUARD}`);
			expect(result.failed).toBe(true);
			expect(result.stderr).toContain('could not put back if the change failed');
		});

		// A DHCP interface is restored by re-enabling the lease, which puts the
		// addresses back itself — nothing is re-created by hand, so nothing is lost.
		it('says nothing about a DHCP interface, whose addresses it never re-creates', async () => {
			expect((await run(`$oldDhcp = 'Enabled'; ${addresses({ ip: '192.0.2.10', origin: 'Dhcp' })}; ${WINDOWS_ORIGIN_GUARD}`)).failed).toBe(false);
		});
	});

	describe('the unchanged-addressing test', () => {
		const config = { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1' } as const;

		/**
		 * Run the assignment against a scripted snapshot and report what it decided.
		 *
		 * The snapshot scripted here is the ACTIVE store's, which is the only one the
		 * decision may read: a persistent-only object is what the interface will come up
		 * with next boot, not what it is on now.
		 */
		async function decide(dhcp: string, address: string, prefix: number, nextHops: string[]): Promise<boolean> {
			const state = [`$oldDhcp = '${dhcp}'`, `$oldActiveAddresses = @([pscustomobject]@{ IPAddress='${address}'; PrefixLength=${prefix} })`, `$oldActiveRoutes = @(${nextHops.map(hop => `[pscustomobject]@{ NextHop='${hop}' }`).join(', ')})`].join('; ');
			const result = await run(`${state}; ${windowsAddressingUnchanged(config)}; if ($addressingUnchanged) { exit 0 } else { exit 3 }`);
			return !result.failed;
		}

		// The union of both stores used to answer this, so an interface holding the
		// requested address and gateway only in the persistent store — with an empty
		// active store — was called already-configured. Nothing was created, and the
		// apply reported success on an interface with no address in force.
		it('does not recognise a configuration only the persistent store holds', async () => {
			const state = ["$oldDhcp = 'Disabled'", '$oldActiveAddresses = @()', '$oldActiveRoutes = @()', "$oldAddresses = @([pscustomobject]@{ IPAddress='192.0.2.10'; PrefixLength=24 })", "$oldRoutes = @([pscustomobject]@{ NextHop='192.0.2.1' })"].join('; ');
			expect((await run(`${state}; ${windowsAddressingUnchanged(config)}; if ($addressingUnchanged) { exit 0 } else { exit 3 }`)).failed).toBe(true);
		});

		it('recognises the configuration already on the interface', async () => {
			expect(await decide('Disabled', '192.0.2.10', 24, ['192.0.2.1'])).toBe(true);
		});

		it('does not recognise a different address, prefix or gateway', async () => {
			expect(await decide('Disabled', '192.0.2.11', 24, ['192.0.2.1'])).toBe(false);
			expect(await decide('Disabled', '192.0.2.10', 25, ['192.0.2.1'])).toBe(false);
			expect(await decide('Disabled', '192.0.2.10', 24, ['192.0.2.2'])).toBe(false);
			expect(await decide('Disabled', '192.0.2.10', 24, [])).toBe(false);
		});

		// The address may read the same and still have to be rewritten: it came from
		// a lease, and the change is to pin it.
		it('does not recognise the same address held by DHCP', async () => {
			expect(await decide('Enabled', '192.0.2.10', 24, ['192.0.2.1'])).toBe(false);
		});
	});

	describe('the duplicate-address-detection wait', () => {
		/**
		 * Drive the wait against a scripted sequence of AddressState values.
		 *
		 * `Get-NetIPAddress` answers one entry of `states` per call and then repeats
		 * the last, which is how a real address behaves — it stops changing once
		 * detection has settled. The clock runs fast and `Start-Sleep` does nothing,
		 * so the 15 s timeout is reached in a handful of iterations rather than in 15
		 * seconds of test time; `Get-Date` is only ever consulted for the deadline and
		 * the loop condition, so advancing it per call is the whole simulation.
		 */
		function wait(states: number[], secondsPerCall: number = 1): string {
			const list = states.join(', ');
			return [`$script:calls = 0`, `$script:states = @(${list})`, `$script:clock = [datetime]'2026-01-01'`, `function Get-Date { $script:clock = $script:clock.AddSeconds(${secondsPerCall}); $script:clock }`, 'function Start-Sleep { }', 'function Get-NetIPAddress { $index = [Math]::Min($script:calls, $script:states.Count - 1); $script:calls++; [pscustomobject]@{ IPAddress = "192.0.2.10"; AddressState = $script:states[$index] } }', '$i = 1', windowsAddressStateWait('192.0.2.10')].join('; ');
		}

		it('accepts an address that reaches Preferred after a few tentative reads', async () => {
			expect(await run(wait([1, 1, 4]))).toEqual({ failed: false, stderr: '' });
		});

		it('accepts an address that is Preferred on the first read', async () => {
			expect((await run(wait([4]))).failed).toBe(false);
		});

		// The case an existence check passes and the reader then contradicts: the
		// object is there, and Windows will not let the host use it.
		it('fails an address that duplicate address detection rejects', async () => {
			const result = await run(wait([1, 2]));
			expect(result.failed).toBe(true);
			expect(result.stderr).toContain('already using that address');
		});

		it('fails an address that never leaves Tentative', async () => {
			const result = await run(wait([1], 5));
			expect(result.failed).toBe(true);
			expect(result.stderr).toContain('still checking the new address for duplicates');
		});

		it('fails an address that Windows will not use for some other reason', async () => {
			// Deprecated: the object exists and the reader will not report it either.
			const result = await run(wait([1, 3]));
			expect(result.failed).toBe(true);
			expect(result.stderr).toContain('will not use it');
		});

		it('fails when the address is not on the interface at all', async () => {
			const gone = ['function Get-NetIPAddress { @() }', 'function Start-Sleep { }', '$i = 1', windowsAddressStateWait('192.0.2.10')].join('; ');
			const result = await run(gone);
			expect(result.failed).toBe(true);
			expect(result.stderr).toContain('is not on the interface');
		});
	});
});
