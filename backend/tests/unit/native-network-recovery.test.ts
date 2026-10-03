import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipv4BaselineOf, type NetInterfaceInfo, type NetworkStateInfo } from '@shared';
import { NativeMutationHost } from '../../src/native/mutation-host.ts';
import { NativeNetworkChanges } from '../../src/native/network-changes.ts';
import { requireNativeMutationContext } from '../../src/native/mutation-context.ts';
import * as profiles from '../../src/native/linux/network-mutation.ts';

const original: NetInterfaceInfo = { id: 'test0', name: 'test0', medium: 'wired', link: 'up', defaultRoute: false, mac: null, addresses: [{ family: 'ipv4', address: '192.0.2.10', prefixLength: 24 }], ipv4Mode: 'static', ipv4Configurable: true, wifiConfigurable: false, gateway: null, dns: [] };

test.each([
	{ label: 'a missing adapter snapshot despite unchanged visible addresses', omitProfile: true, address: '192.0.2.10', extraAddress: false, appliesToDevice: true, matchesDesired: false, fingerprint: 'a'.repeat(64), expected: 'interrupted' },
	{ label: 'another active profile with identical visible addresses', address: '192.0.2.10', extraAddress: false, appliesToDevice: false, matchesDesired: false, fingerprint: 'a'.repeat(64), expected: 'interrupted' },
	{ label: 'an additional unexpected IPv4 address', address: '192.0.2.10', extraAddress: true, appliesToDevice: true, matchesDesired: false, fingerprint: 'a'.repeat(64), expected: 'interrupted' },
	{ label: 'a changed saved DNS policy with the same visible addresses', address: '192.0.2.10', extraAddress: false, appliesToDevice: true, matchesDesired: false, fingerprint: 'b'.repeat(64), expected: 'interrupted' },
	{ label: 'the original profile and original kernel state', address: '192.0.2.10', extraAddress: false, appliesToDevice: true, matchesDesired: false, fingerprint: 'a'.repeat(64), expected: undefined },
	{ label: 'the desired profile and desired kernel state', address: '192.0.2.20', extraAddress: false, appliesToDevice: true, matchesDesired: true, fingerprint: 'b'.repeat(64), expected: undefined },
])('recovery handles $label', async scenario => {
	const directory = await mkdtemp(join(tmpdir(), 'native-network-recovery-'));
	const host = new NativeMutationHost(directory);
	let iface = structuredClone(original);
	let reads = 0;
	const snapshot = (): NetworkStateInfo => ({ interfaces: [iface], primaryID: iface.id, known: true, detail: 'full', ipv4ProfilesUnavailable: false, capabilities: { ipv4: true, wifi: false, staticGatewayRequired: false } });
	const changes = new NativeNetworkChanges(host, async () => {
		reads++;
		return snapshot();
	});
	const observation = spyOn(host, 'observe').mockImplementation(async record => ({ bootId: 'new-boot', executor: { identity: record.executor, state: 'ended' } }));
	const profile = spyOn(profiles, 'observeNativeLinuxIPv4Profile').mockResolvedValue({ exists: true, appliesToDevice: scenario.appliesToDevice, matchesDesired: scenario.matchesDesired, fingerprint: scenario.fingerprint });
	try {
		const pending = await changes.applyIPv4('test0', { mode: 'static', address: '192.0.2.20', prefixLength: 24 }, ipv4BaselineOf(original), async () => {
			const context = requireNativeMutationContext();
			if (!('omitProfile' in scenario)) await context.recordRecovery({ profilePath: '/profile/1', profileUuid: 'profile-uuid', originalProfileFingerprint: 'a'.repeat(64) });
			return context.pending({ kind: 'boot' });
		});
		expect(pending.mutation?.state).toBe('pending');
		iface = { ...structuredClone(original), addresses: [{ family: 'ipv4', address: scenario.address, prefixLength: 24 }], ipv4Configurable: !scenario.extraAddress };
		if (scenario.extraAddress) iface.addresses.push({ family: 'ipv4', address: '192.0.2.90', prefixLength: 24 });
		const priorReads = reads;
		changes.startRecovery();
		const deadline = performance.now() + 3000;
		let state = await changes.state();
		while (state?.state === 'pending' || state?.state === 'settling') {
			if (performance.now() > deadline) throw new Error('Recovery did not finish');
			await Bun.sleep(10);
			state = await changes.state();
		}
		expect(state?.state).toBe(scenario.expected);
		if (!('omitProfile' in scenario)) expect(reads).toBeGreaterThan(priorReads);
	} finally {
		observation.mockRestore();
		profile.mockRestore();
		expect(host.close()).toBe(true);
		await Bun.sleep(20);
		await rm(directory, { recursive: true, force: true });
	}
});
