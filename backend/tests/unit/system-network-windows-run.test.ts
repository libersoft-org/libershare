import { describe, it, expect } from 'bun:test';
import { windowsApplyIPv4Command } from '../../src/system-network-windows.ts';
import { INFINITE_LIFETIME, runWindowsApplyScript, staticHost, type FakeHost } from './helpers/windows-apply-harness.ts';

const GUID = '{2B1F0E8A-4C3D-4E5F-9A7B-1C2D3E4F5A6B}';
const windowsOnly = process.platform !== 'win32';

/**
 * The apply script, executed rather than inspected.
 *
 * Every other test on this command reads its TEXT, which cannot answer what the
 * script does at runtime: which branch a DNS-only change takes, whether a rollback
 * reaches the address at all, or which policy store an object ends up in. Those
 * are the questions the last round of failures were about, so they are asked of
 * PowerShell itself, against fake cmdlets that model store membership.
 *
 * Skipped off Windows — there is no PowerShell to ask.
 */
describe('windowsApplyIPv4Command, executed', () => {
	it.skipIf(windowsOnly)('applies a static configuration and leaves it in both stores', async () => {
		const host = staticHost(GUID, { addresses: [], routes: [], nameServer: '' });
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '192.0.2.20', prefixLength: 24, gateway: '192.0.2.1', dns: ['198.51.100.1'] }), host);
		expect(result.error).toBeNull();
		expect(result.addresses).toHaveLength(1);
		expect(result.addresses[0]?.IPAddress).toBe('192.0.2.20');
		expect(result.addresses[0]?.Stores.sort()).toEqual(['ActiveStore', 'PersistentStore']);
		expect(result.dns).toEqual(['198.51.100.1']);
	});

	// The persistent copy is the one a reboot loads. Clearing only the active store
	// left it behind, so the interface came back up carrying the old address beside
	// the new one — and the alias guard then refused to edit the interface at all.
	it.skipIf(windowsOnly)('clears a persistent copy of the address it replaces', async () => {
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '192.0.2.20', prefixLength: 24, gateway: '192.0.2.1' }), staticHost(GUID));
		expect(result.error).toBeNull();
		expect(result.addresses.map(a => a.IPAddress)).toEqual(['192.0.2.20']);
		expect(result.routes.map(r => r.NextHop)).toEqual(['192.0.2.1']);
	});

	// A rejected configuration that reinstates itself at the next boot is worse than
	// one that never applied: the RPC reported an error, the user saw the old
	// address back, and the machine changed its mind hours later.
	it.skipIf(windowsOnly)('leaves no trace of a rejected address in either store', async () => {
		const host = staticHost(GUID, { failOn: 'Set-DnsClientServerAddress' });
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '198.51.100.20', prefixLength: 24, gateway: '198.51.100.1', dns: ['198.51.100.53'] }), host);
		expect(result.error).toContain('injected failure');
		expect(result.addresses.map(a => a.IPAddress)).toEqual(['192.0.2.10']);
		expect(result.addresses[0]?.Stores.sort()).toEqual(['ActiveStore', 'PersistentStore']);
		expect(result.routes.map(r => r.NextHop)).toEqual(['192.0.2.1']);
	});

	// An address that was active-only must not come back persistent: the rollback
	// would then have added a configuration to the next boot that the interface
	// never had.
	it.skipIf(windowsOnly)('restores an active-only address as active-only', async () => {
		const host = staticHost(GUID, { failOn: 'Set-DnsClientServerAddress' });
		host.addresses[0]!.Stores = ['ActiveStore'];
		host.routes[0]!.Stores = ['ActiveStore'];
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '198.51.100.20', prefixLength: 24, gateway: '198.51.100.1' }), host);
		expect(result.error).toContain('injected failure');
		expect(result.addresses.map(a => a.Stores)).toEqual([['ActiveStore']]);
		expect(result.routes.map(r => r.Stores)).toEqual([['ActiveStore']]);
	});

	// The persistent store legitimately holds objects the active store does not.
	// Reading only the active one made such an interface look unconfigured, so the
	// rollback wrote that emptiness back as its former state.
	it.skipIf(windowsOnly)('sees and restores an address held only in the persistent store', async () => {
		const host: FakeHost = { guid: GUID, dhcp: 'Disabled', addresses: [{ IPAddress: '192.0.2.10', PrefixLength: 24, PrefixOrigin: 'Manual', SuffixOrigin: 'Manual', SkipAsSource: false, ValidLifetime: INFINITE_LIFETIME, PreferredLifetime: INFINITE_LIFETIME, Type: 'Unicast', Stores: ['PersistentStore'] }], routes: [], nameServer: '', failOn: 'Set-DnsClientServerAddress' };
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '198.51.100.20', prefixLength: 24 }), host);
		expect(result.error).toContain('injected failure');
		expect(result.addresses.map(a => a.IPAddress)).toEqual(['192.0.2.10']);
		expect(result.addresses.map(a => a.Stores)).toEqual([['PersistentStore']]);
	});

	// Counted across both stores, and deduplicated: one address held in both is one
	// address, while an interface whose second address exists only in the persistent
	// store is still an interface this app cannot preserve.
	it.skipIf(windowsOnly)('counts an alias that lives only in the persistent store', async () => {
		const host = staticHost(GUID);
		host.addresses.push({ IPAddress: '192.0.2.11', PrefixLength: 24, PrefixOrigin: 'Manual', SuffixOrigin: 'Manual', SkipAsSource: false, ValidLifetime: INFINITE_LIFETIME, PreferredLifetime: INFINITE_LIFETIME, Type: 'Unicast', Stores: ['PersistentStore'] });
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '198.51.100.20', prefixLength: 24 }), host);
		expect(result.error).toContain('several IPv4 addresses');
		// Refused before the first removal, so nothing was touched.
		expect(result.calls).not.toContain('Remove-NetIPAddress:ActiveStore');
	});
});
