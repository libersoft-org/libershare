import { describe, it, expect } from 'bun:test';
import { windowsApplyIPv4Command } from '../../src/system-network-windows.ts';
import { INFINITE_LIFETIME, inStore, runWindowsApplyScript, staticHost, type FakeHost } from './helpers/windows-apply-harness.ts';

const GUID = '{2B1F0E8A-4C3D-4E5F-9A7B-1C2D3E4F5A6B}';
const windowsOnly = process.platform !== 'win32';
/** A lease's countdown, as Windows reports the remaining half of a renewal interval. */
const LEASED_LIFETIME = '00:10:00';

/** An interface on DHCP: one leased address and, unless overridden, the lease's own default route. */
function leasedHost(overrides: Partial<FakeHost> = {}): FakeHost {
	return { guid: GUID, dhcp: 'Enabled', addresses: [{ Store: 'ActiveStore', IPAddress: '203.0.113.50', PrefixLength: 24, PrefixOrigin: 'Dhcp', SuffixOrigin: 'Dhcp', SkipAsSource: false, ValidLifetime: LEASED_LIFETIME, PreferredLifetime: LEASED_LIFETIME, Type: 'Unicast' }], routes: [{ Store: 'ActiveStore', NextHop: '203.0.113.1', RouteMetric: 0, Protocol: 'NetMgmt', Publish: 'No', ValidLifetime: LEASED_LIFETIME, PreferredLifetime: LEASED_LIFETIME }], nameServer: '', ...overrides };
}

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
		expect(inStore(result.addresses, 'ActiveStore').map(a => a.IPAddress)).toEqual(['192.0.2.20']);
		expect(inStore(result.addresses, 'PersistentStore').map(a => a.IPAddress)).toEqual(['192.0.2.20']);
		expect(result.dns).toEqual(['198.51.100.1']);
	});

	// The persistent copy is the one a reboot loads. Clearing only the active store
	// left it behind, so the interface came back up carrying the old address beside
	// the new one — and the alias guard then refused to edit the interface at all.
	it.skipIf(windowsOnly)('clears a persistent copy of the address it replaces', async () => {
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '192.0.2.20', prefixLength: 24, gateway: '192.0.2.1' }), staticHost(GUID));
		expect(result.error).toBeNull();
		expect(inStore(result.addresses, 'PersistentStore').map(a => a.IPAddress)).toEqual(['192.0.2.20']);
		expect(inStore(result.routes, 'PersistentStore').map(r => r.NextHop)).toEqual(['192.0.2.1']);
	});

	// A rejected configuration that reinstates itself at the next boot is worse than
	// one that never applied: the RPC reported an error, the user saw the old
	// address back, and the machine changed its mind hours later.
	it.skipIf(windowsOnly)('leaves no trace of a rejected address in either store', async () => {
		const host = staticHost(GUID, { failOn: 'Set-DnsClientServerAddress' });
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '198.51.100.20', prefixLength: 24, gateway: '198.51.100.1', dns: ['198.51.100.53'] }), host);
		expect(result.error).toContain('injected failure');
		expect(inStore(result.addresses, 'ActiveStore').map(a => a.IPAddress)).toEqual(['192.0.2.10']);
		expect(inStore(result.addresses, 'PersistentStore').map(a => a.IPAddress)).toEqual(['192.0.2.10']);
		expect(inStore(result.routes, 'ActiveStore').map(r => r.NextHop)).toEqual(['192.0.2.1']);
		expect(inStore(result.routes, 'PersistentStore').map(r => r.NextHop)).toEqual(['192.0.2.1']);
	});

	// An address that was active-only must not come back persistent: the rollback
	// would then have added a configuration to the next boot that the interface
	// never had.
	it.skipIf(windowsOnly)('restores an active-only address as active-only', async () => {
		const host = staticHost(GUID, { failOn: 'Set-DnsClientServerAddress' });
		host.addresses = inStore(host.addresses, 'ActiveStore');
		host.routes = inStore(host.routes, 'ActiveStore');
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '198.51.100.20', prefixLength: 24, gateway: '198.51.100.1' }), host);
		expect(result.error).toContain('injected failure');
		expect(result.addresses.map(a => a.Store)).toEqual(['ActiveStore']);
		expect(result.routes.map(r => r.Store)).toEqual(['ActiveStore']);
	});

	// The persistent store legitimately holds objects the active store does not.
	// Reading only the active one made such an interface look unconfigured, so the
	// rollback wrote that emptiness back as its former state.
	it.skipIf(windowsOnly)('sees and restores an address held only in the persistent store', async () => {
		const host: FakeHost = { guid: GUID, dhcp: 'Disabled', addresses: [{ Store: 'PersistentStore', IPAddress: '192.0.2.10', PrefixLength: 24, PrefixOrigin: 'Manual', SuffixOrigin: 'Manual', SkipAsSource: false, ValidLifetime: INFINITE_LIFETIME, PreferredLifetime: INFINITE_LIFETIME, Type: 'Unicast' }], routes: [], nameServer: '', failOn: 'Set-DnsClientServerAddress' };
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '198.51.100.20', prefixLength: 24 }), host);
		expect(result.error).toContain('injected failure');
		expect(result.addresses.map(a => a.IPAddress)).toEqual(['192.0.2.10']);
		expect(result.addresses.map(a => a.Store)).toEqual(['PersistentStore']);
		// And it got there the only way the provider allows: created into both stores,
		// then the active copy taken away. Neither creating cmdlet can be pointed at the
		// persistent store, so a rollback that tries lands in the catch that reports the
		// apply as unrecoverable.
		expect(result.calls).toContain('New-NetIPAddress:ActiveStore+PersistentStore');
		expect(result.calls.filter(call => call.startsWith('New-') && call.includes('PersistentStore') && !call.includes('+'))).toEqual([]);
	});

	// The two stores are free to disagree about an object they both hold, because
	// Set-NetIPAddress and Set-NetRoute can be pointed at the active store alone. A
	// rollback that matched on identity and then restored both copies from the ACTIVE
	// one rewrote the startup configuration while reporting it had changed nothing.
	it.skipIf(windowsOnly)('restores each store its own copy of one next hop', async () => {
		const host = staticHost(GUID, { failOn: 'Set-DnsClientServerAddress' });
		host.routes = [
			{ Store: 'ActiveStore', NextHop: '192.0.2.1', RouteMetric: 5, Protocol: 'NetMgmt', Publish: 'No', ValidLifetime: '00:30:00', PreferredLifetime: '00:30:00' },
			{ Store: 'PersistentStore', NextHop: '192.0.2.1', RouteMetric: 100, Protocol: 'NetMgmt', Publish: 'Yes', ValidLifetime: INFINITE_LIFETIME, PreferredLifetime: INFINITE_LIFETIME },
		];
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '198.51.100.20', prefixLength: 24, gateway: '198.51.100.1' }), host);
		expect(result.error).toContain('injected failure');
		expect(inStore(result.routes, 'ActiveStore').map(r => [r.RouteMetric, r.Publish, r.ValidLifetime])).toEqual([[5, 'No', '00:30:00']]);
		expect(inStore(result.routes, 'PersistentStore').map(r => [r.RouteMetric, r.Publish, r.ValidLifetime])).toEqual([[100, 'Yes', INFINITE_LIFETIME]]);
	});

	// The same for an address: an active Anycast copy against a persistent Unicast one
	// is a state the machine can be put into, so it is one the rollback has to hand
	// back as it found it.
	it.skipIf(windowsOnly)('restores each store its own copy of one address', async () => {
		const host = staticHost(GUID, { failOn: 'Set-DnsClientServerAddress' });
		host.addresses = [
			{ Store: 'ActiveStore', IPAddress: '192.0.2.10', PrefixLength: 24, PrefixOrigin: 'Manual', SuffixOrigin: 'Manual', SkipAsSource: true, ValidLifetime: '00:30:00', PreferredLifetime: '00:30:00', Type: 'Anycast' },
			{ Store: 'PersistentStore', IPAddress: '192.0.2.10', PrefixLength: 24, PrefixOrigin: 'Manual', SuffixOrigin: 'Manual', SkipAsSource: false, ValidLifetime: INFINITE_LIFETIME, PreferredLifetime: INFINITE_LIFETIME, Type: 'Unicast' },
		];
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '198.51.100.20', prefixLength: 24 }), host);
		expect(result.error).toContain('injected failure');
		expect(inStore(result.addresses, 'ActiveStore').map(a => [a.Type, a.SkipAsSource, a.ValidLifetime])).toEqual([['Anycast', true, '00:30:00']]);
		expect(inStore(result.addresses, 'PersistentStore').map(a => [a.Type, a.SkipAsSource, a.ValidLifetime])).toEqual([['Unicast', false, INFINITE_LIFETIME]]);
	});

	// The form posts the whole configuration whichever field was edited, so the
	// ordinary apply is a DNS-only one. Undoing a failed resolver write by clearing
	// every address and default route and rebuilding them changes store membership,
	// route metrics and address types on an interface nobody asked to re-address.
	it.skipIf(windowsOnly)('touches no address or route when only the resolvers fail', async () => {
		const host = staticHost(GUID, { failOn: 'Set-DnsClientServerAddress' });
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['198.51.100.53'] }), host);
		expect(result.error).toContain('injected failure');
		for (const destructive of ['Remove-NetIPAddress', 'Remove-NetRoute', 'New-NetIPAddress', 'New-NetRoute']) expect(result.calls.filter(call => call.startsWith(destructive))).toEqual([]);
		// And the interface is exactly as it was found, metric included.
		expect(inStore(result.addresses, 'ActiveStore').map(a => a.IPAddress)).toEqual(['192.0.2.10']);
		expect(result.routes.map(r => r.RouteMetric)).toEqual([25, 25]);
	});

	// ...but "already configured" is a question about the ACTIVE store. An interface
	// whose address and gateway exist only in the persistent store is one that will
	// come up on them at the next boot and has none of them now, so submitting those
	// same values — which the form does whichever field was edited — has to create
	// them. Asked of the union of both stores, this branch was skipped and the apply
	// reported success on an interface still holding no IPv4 address at all.
	it.skipIf(windowsOnly)('applies a configuration the persistent store alone already holds', async () => {
		const host = staticHost(GUID);
		host.addresses = inStore(host.addresses, 'PersistentStore');
		host.routes = inStore(host.routes, 'PersistentStore');
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['198.51.100.53'] }), host);
		expect(result.error).toBeNull();
		expect(inStore(result.addresses, 'ActiveStore').map(a => a.IPAddress)).toEqual(['192.0.2.10']);
		expect(inStore(result.routes, 'ActiveStore').map(r => r.NextHop)).toEqual(['192.0.2.1']);
		expect(result.calls).toContain('New-NetIPAddress:ActiveStore+PersistentStore');
	});

	// Duplicate address detection hangs off the same flag: with no new address there
	// is nothing to wait for, and the wait would have been reading the old one.
	it.skipIf(windowsOnly)('runs no duplicate address detection when nothing was created', async () => {
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['198.51.100.53'] }), staticHost(GUID));
		expect(result.error).toBeNull();
		expect(result.calls).toEqual(['Get-NetIPInterface', 'Get-NetIPAddress:ActiveStore', 'Get-NetIPAddress:PersistentStore', 'Get-NetRoute:ActiveStore', 'Get-NetRoute:PersistentStore', 'Get-ItemProperty', 'Set-DnsClientServerAddress:set']);
	});

	// A rollback that reports "the change was undone" has to hand back the object it
	// removed, not one that merely has the same address on it.
	it.skipIf(windowsOnly)('hands back an anycast address and a temporary route unchanged', async () => {
		const host = staticHost(GUID, { failOn: 'Set-DnsClientServerAddress' });
		for (const address of host.addresses) address.Type = 'Anycast';
		for (const route of host.routes) {
			route.ValidLifetime = '00:30:00';
			route.PreferredLifetime = '00:30:00';
		}
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '198.51.100.20', prefixLength: 24, gateway: '198.51.100.1' }), host);
		expect(result.error).toContain('injected failure');
		expect(result.addresses.map(a => a.Type)).toEqual(['Anycast', 'Anycast']);
		expect(result.routes.map(r => r.ValidLifetime)).toEqual(['00:30:00', '00:30:00']);
		expect(result.routes.map(r => r.RouteMetric)).toEqual([25, 25]);
	});

	// The route is created as a side effect of New-NetIPAddress -DefaultGateway,
	// which has no metric parameter, so changing an address on an interface whose
	// gateway did not move re-ranked that route against every other default route on
	// the host — on a multihomed machine, a change of which interface traffic leaves
	// by.
	it.skipIf(windowsOnly)('keeps the default route metric when only the address changes', async () => {
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '192.0.2.30', prefixLength: 24, gateway: '192.0.2.1' }), staticHost(GUID));
		expect(result.error).toBeNull();
		expect(inStore(result.addresses, 'ActiveStore').map(a => a.IPAddress)).toEqual(['192.0.2.30']);
		expect(result.routes.map(r => r.RouteMetric)).toEqual([25, 25]);
	});

	// The rollback already handed these back; the SUCCESS path was dropping them. An
	// interface whose address is not changing — the user moved the gateway, or only
	// the resolvers, and the form posts the whole configuration either way — came back
	// Unicast, answering for outgoing traffic, and permanent.
	it.skipIf(windowsOnly)('keeps an anycast address and a temporary route across a successful change', async () => {
		const host = staticHost(GUID);
		for (const address of host.addresses) {
			address.Type = 'Anycast';
			address.SkipAsSource = true;
			address.ValidLifetime = '02:00:00';
			address.PreferredLifetime = '02:00:00';
		}
		for (const route of host.routes) {
			route.Publish = 'Yes';
			route.ValidLifetime = '00:45:00';
			route.PreferredLifetime = '00:45:00';
		}
		// Same address, same gateway, a different prefix — so the rewrite runs.
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '192.0.2.10', prefixLength: 25, gateway: '192.0.2.1' }), host);
		expect(result.error).toBeNull();
		expect(inStore(result.addresses, 'ActiveStore').map(a => [a.Type, a.SkipAsSource, a.ValidLifetime])).toEqual([['Anycast', true, '02:00:00']]);
		expect(inStore(result.routes, 'ActiveStore').map(r => [r.RouteMetric, r.Publish, r.ValidLifetime])).toEqual([[25, 'Yes', '00:45:00']]);
	});

	// ...and an address that IS moving takes none of them: those properties belonged
	// to the object being replaced.
	it.skipIf(windowsOnly)('lets Windows choose the properties of an address that moved', async () => {
		const host = staticHost(GUID);
		for (const address of host.addresses) address.Type = 'Anycast';
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '192.0.2.30', prefixLength: 24, gateway: '192.0.2.1' }), host);
		expect(result.error).toBeNull();
		// No -Type was passed at all, which is what leaves Windows its own default.
		expect(inStore(result.addresses, 'ActiveStore')[0]?.Type).toBeFalsy();
	});

	it.skipIf(windowsOnly)('takes no metric from a route to a different gateway', async () => {
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '198.51.100.30', prefixLength: 24, gateway: '198.51.100.1' }), staticHost(GUID));
		expect(result.error).toBeNull();
		expect(result.calls).not.toContain('Set-NetRoute');
		expect(inStore(result.routes, 'ActiveStore').map(r => r.NextHop)).toEqual(['198.51.100.1']);
	});

	// A DHCP interface carrying a hand-added default route. The rollback used to
	// re-enable DHCP and stop, so the route was gone for good — and if it was the
	// only path into the network the host is administered over, so was the host.
	it.skipIf(windowsOnly)('puts a DHCP interface manual default route back after a failed apply', async () => {
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '198.51.100.20', prefixLength: 24, gateway: '198.51.100.1' }), leasedHost({ failOn: 'Set-DnsClientServerAddress', routes: [{ Store: 'ActiveStore', NextHop: '203.0.113.1', RouteMetric: 5, Protocol: 'NetMgmt', Publish: 'No', ValidLifetime: INFINITE_LIFETIME, PreferredLifetime: INFINITE_LIFETIME }] }));
		expect(result.error).toContain('injected failure');
		expect(result.dhcp).toBe('Enabled');
		expect(result.routes.map(r => r.NextHop)).toEqual(['203.0.113.1']);
		expect(result.routes[0]?.RouteMetric).toBe(5);
		expect(result.routes[0]?.Store).toBe('ActiveStore');
	});

	// The other half of the same rule: a route the lease handed out comes back with
	// the lease, so re-adding it by hand would install a static copy beside it.
	it.skipIf(windowsOnly)('leaves a leased default route to come back with the lease', async () => {
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '198.51.100.20', prefixLength: 24, gateway: '198.51.100.1' }), leasedHost({ failOn: 'Set-DnsClientServerAddress' }));
		expect(result.error).toContain('injected failure');
		expect(result.dhcp).toBe('Enabled');
		expect(result.routes).toEqual([]);
		expect(result.calls.filter(call => call.startsWith('New-NetRoute'))).toEqual([]);
		// And no static copy of the leased address is left behind either — the
		// interface is handed back to DHCP holding nothing.
		expect(result.addresses).toEqual([]);
	});

	// Counted across both stores, and deduplicated: one address held in both is one
	// address, while an interface whose second address exists only in the persistent
	// store is still an interface this app cannot preserve.
	it.skipIf(windowsOnly)('counts an alias that lives only in the persistent store', async () => {
		const host = staticHost(GUID);
		host.addresses.push({ Store: 'PersistentStore', IPAddress: '192.0.2.11', PrefixLength: 24, PrefixOrigin: 'Manual', SuffixOrigin: 'Manual', SkipAsSource: false, ValidLifetime: INFINITE_LIFETIME, PreferredLifetime: INFINITE_LIFETIME, Type: 'Unicast' });
		const result = await runWindowsApplyScript(windowsApplyIPv4Command(GUID, { mode: 'static', address: '198.51.100.20', prefixLength: 24 }), host);
		expect(result.error).toContain('several IPv4 addresses');
		// Refused before the first removal, so nothing was touched.
		expect(result.calls).not.toContain('Remove-NetIPAddress:ActiveStore');
	});
});
