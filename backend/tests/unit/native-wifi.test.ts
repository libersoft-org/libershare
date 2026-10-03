import { describe, expect, test } from 'bun:test';
import { DBusError, variant } from '../../src/native/linux/dbus.ts';
import { NativeMutationUnknown } from '../../src/native/mutation-host.ts';
import { connectNativeLinuxWifi, disconnectNativeLinuxWifi, StoredWifiSecretUnavailable } from '../../src/native/linux/wifi-mutation.ts';
import { isWifiRecoveryData, observeNativeLinuxWifi } from '../../src/native/linux/wifi-recovery.ts';
import { wifiPersonalSecurity, wifiProfileCompatible, wifiProfileFingerprint, type WifiAccessPoint } from '../../src/native/linux/wifi-settings.ts';
import { AP, BSSID, NEW_PASSWORD, OLD_PASSWORD, PROFILE, ROOT, UUID, wifiFixture, wifiOptions, wifiSettings } from './fixtures/native-wifi.ts';

const ap: WifiAccessPoint = { path: AP, ssid: Buffer.from('Demo'), bssid: BSSID, mode: 2, frequency: 2412, flags: 1, wpa: 0, rsn: 0x188 };

describe('NetworkManager 1.46 AP/profile compatibility', () => {
	test('new transition-mode profiles default to PSK and SAE-only profiles keep SAE', () => {
		expect(wifiPersonalSecurity({ ...ap, rsn: 0x588 })).toBe('wpa-psk');
		expect(wifiPersonalSecurity({ ...ap, rsn: 0x488 })).toBe('sae');
	});
	test('matches SSID bytes, BSSID, mode, band and exact channel', () => {
		const settings = wifiSettings();
		expect(wifiProfileCompatible(settings, ap)).toBe(true);
		for (const [key, val] of [
			['ssid', variant('ay', Buffer.from('Other'))],
			['bssid', variant('ay', Buffer.alloc(6))],
			['mode', variant('s', 'ap')],
			['band', variant('s', 'a')],
			['channel', variant('u', 6)],
		] as const) {
			const changed = structuredClone(settings);
			changed['802-11-wireless']![key] = val;
			expect(wifiProfileCompatible(changed, ap)).toBe(false);
		}
		settings['802-11-wireless']!['channel'] = variant('u', 1);
		expect(wifiProfileCompatible(settings, ap)).toBe(true);
	});
	test('checks pairwise/group ciphers across WPA and RSN without constraining proto', () => {
		const settings = wifiSettings(),
			security = settings['802-11-wireless-security']!;
		security['proto'] = variant('as', ['wpa']);
		security['pairwise'] = variant('as', ['ccmp']);
		security['group'] = variant('as', ['ccmp']);
		expect(wifiProfileCompatible(settings, ap)).toBe(true);
		security['pairwise'] = variant('as', ['tkip']);
		expect(wifiProfileCompatible(settings, ap)).toBe(false);
		security['pairwise'] = variant('as', ['ccmp']);
		security['group'] = variant('as', ['wep40']);
		expect(wifiProfileCompatible(settings, ap)).toBe(false);
	});
	test('key management and infrastructure/ad-hoc constraints follow the NM predicate', () => {
		for (const [key, flags, allowed] of [
			['wpa-psk', 0x188, true],
			['sae', 0x488, true],
			['sae', 0x188, false],
			['wpa-eap', 0x288, true],
			['owe', 0x888, true],
			['wpa-eap-suite-b-192', 0x2000, true],
		] as const) {
			const settings = wifiSettings();
			settings['802-11-wireless-security']!['key-mgmt'] = variant('s', key);
			expect(wifiProfileCompatible(settings, { ...ap, rsn: flags })).toBe(allowed);
		}
		expect(wifiProfileCompatible(wifiSettings(), { ...ap, mode: 1 })).toBe(false);
		expect(wifiProfileCompatible(wifiSettings(), { ...ap, mode: 0 })).toBe(false);
		expect(wifiProfileCompatible(wifiSettings(UUID, 0, true), { ...ap, flags: 0, rsn: 0 })).toBe(true);
	});
});

describe('native Wi-Fi transactions', () => {
	test('open existing/new profiles never read or write passwords', async () => {
		for (const existing of [true, false]) {
			const f = wifiFixture({ open: true, existing });
			await connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', '', BSSID, wifiOptions, f.deps);
			expect(f.writes.map(call => call.member)).toEqual(['CheckpointCreate', existing ? 'ActivateConnection' : 'AddAndActivateConnection2', 'CheckpointDestroy']);
			expect(f.reads.some(call => call.member === 'GetSecrets')).toBe(false);
			expect(JSON.stringify(f.writes)).not.toContain('psk');
			expect((await observeNativeLinuxWifi(f.records[f.records.length - 1], 5000, f.deps)).targetMatches).toBe(true);
		}
	});
	test('stored PSK is verified on a volatile clone before updating and activating the original UUID', async () => {
		const f = wifiFixture();
		await connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, f.deps);
		expect(f.writes.map(call => call.member)).toEqual(['CheckpointCreate', 'AddAndActivateConnection2', 'Update2', 'ActivateConnection', 'CheckpointDestroy']);
		expect(f.writes[1]!.args?.[3]).toEqual({ persist: variant('s', 'volatile') });
		expect(f.writes[2]!.path).toBe(PROFILE);
		expect(f.writes[2]!.args?.[1]).toBe(0x20);
		expect(f.profiles.size).toBe(1);
		expect(f.state.active).toBe(PROFILE);
		expect(f.secrets.get(PROFILE)).toBe(NEW_PASSWORD);
		const journal = JSON.stringify(f.records);
		expect(journal).not.toContain(OLD_PASSWORD);
		expect(journal).not.toContain(NEW_PASSWORD);
		expect(f.records.some(record => record.phase === 'commit' && record.credentialVerified)).toBe(true);
		expect((await observeNativeLinuxWifi(f.records[f.records.length - 1], 5000, f.deps)).outcome).toBe('target');
	});
	test('agent-owned and unsaved PSK flags use the original profile without a clone or GetSecrets', async () => {
		for (const flags of [1, 2]) {
			const f = wifiFixture({ flags });
			await connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, f.deps);
			expect(f.writes.map(call => call.member)).toEqual(['CheckpointCreate', 'Update2', 'ActivateConnection', 'CheckpointDestroy']);
			expect(f.reads.some(call => call.member === 'GetSecrets')).toBe(false);
			expect(f.profiles.get(PROFILE)!['802-11-wireless-security']!['psk-flags']!.value).toBe(flags);
			expect(f.secrets.has(PROFILE)).toBe(false);
			expect(f.agentScopes).toEqual([{ profilePath: PROFILE, uuid: UUID, ssidHex: Buffer.from('Demo').toString('hex'), authentication: 'wpa-psk', password: NEW_PASSWORD }]);
			expect(f.state.secretAgent).toBe(false);
			expect(f.state.closed).toBe(true);
		}
	});
	test('a saved SAE profile on a WPA2/WPA3 network hands the agent SAE, not the PSK default for new profiles', async () => {
		const f = wifiFixture({ flags: 1 });
		f.profiles.get(PROFILE)!['802-11-wireless-security']!['key-mgmt'] = variant('s', 'sae');
		f.state.rsn = 0x588;
		await connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, f.deps);
		expect(f.agentScopes.map(scope => scope.authentication)).toEqual(['sae']);
		expect(f.state.active).toBe(PROFILE);
		expect(f.records.every(record => record.targetAuthentication === 'sae')).toBe(true);
	});
	test('a known activation failure releases the entered password before restoring an agent-owned profile', async () => {
		const f = wifiFixture({ flags: 1, active: true });
		f.state.failure = 'original-activation';
		await expect(connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, f.deps)).rejects.toThrow('activation failed');
		expect(f.writes.some(call => call.member === 'CheckpointRollback')).toBe(true);
		expect(f.state.active).toBe(PROFILE);
		expect(f.state.secretAgent).toBe(false);
		expect(f.state.closed).toBe(true);
	});
	test('a Wi-Fi rollback that never goes quiet stays pending instead of rolled back', async () => {
		const f = wifiFixture({ flags: 1, active: true });
		f.state.failure = 'original-activation';
		const mutate = f.deps.mutate;
		f.deps.mutate = async (context, endpoint, request) => {
			if (request.member === 'CheckpointRollback') f.state.rollbackBusy = Number.MAX_SAFE_INTEGER;
			return mutate(context, endpoint, request);
		};
		await expect(connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, f.deps)).rejects.toBeInstanceOf(NativeMutationUnknown);
		expect(f.state.pending).toBe(true);
		expect(f.records.some(record => record.phase === 'rolled-back')).toBe(false);
	});
	test('an unknown activation retains its credential worker and never starts rollback', async () => {
		const f = wifiFixture({ flags: 2 });
		f.state.unknown = 'ActivateConnection';
		await expect(connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, f.deps)).rejects.toThrow();
		expect(f.writes.some(call => call.member === 'CheckpointRollback')).toBe(false);
		expect(f.state.secretAgent).toBe(true);
		expect(f.state.retained).toBe(true);
		expect(f.state.closed).toBe(false);
	});
	test('failed agent registration leaves the profile untouched and creates no checkpoint', async () => {
		const f = wifiFixture({ flags: 1 });
		f.state.failure = 'secret-agent';
		await expect(connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, f.deps)).rejects.toThrow();
		expect(f.writes).toHaveLength(0);
		expect(f.state.closed).toBe(true);
	});
	test('new protected profile is created once with the caller-selected AP', async () => {
		const f = wifiFixture({ existing: false });
		await connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, f.deps);
		expect(f.writes.map(call => call.member)).toEqual(['CheckpointCreate', 'AddAndActivateConnection2', 'CheckpointDestroy']);
		expect(f.writes[1]!.args?.[2]).toBe(AP);
		expect(f.profiles.size).toBe(1);
		expect((await observeNativeLinuxWifi(f.records[f.records.length - 1], 5000, f.deps)).targetMatches).toBe(true);
	});
	test('AvailableConnections order wins and incompatible cipher profiles are skipped', async () => {
		const f = wifiFixture({ flags: 1 });
		const incompatible = wifiSettings('00000000-0000-4000-8000-000000000002', 1);
		incompatible['802-11-wireless-security']!['pairwise'] = variant('as', ['tkip']);
		const first = `${ROOT}/Settings/3`;
		f.profiles.set(`${ROOT}/Settings/2`, incompatible);
		f.profiles.set(first, wifiSettings('00000000-0000-4000-8000-000000000003', 1));
		f.state.candidates = [`${ROOT}/Settings/2`, first, PROFILE];
		await connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, f.deps);
		expect(f.writes.find(call => call.member === 'Update2')!.path).toBe(first);
	});
	test('unsupported AP security and incomplete secret snapshots fail before checkpoint creation', async () => {
		for (const flags of [0, 0x288, 0x888, 0x1000]) {
			const f = wifiFixture();
			f.state.rsn = flags;
			await expect(connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, f.deps)).rejects.toThrow('not supported');
			expect(f.writes).toHaveLength(0);
		}
		const missing = wifiFixture();
		missing.secrets.clear();
		await expect(connectNativeLinuxWifi(missing.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, missing.deps)).rejects.toBeInstanceOf(StoredWifiSecretUnavailable);
		expect(missing.writes).toHaveLength(0);
		const denied = wifiFixture();
		denied.state.failSecrets = true;
		await expect(connectNativeLinuxWifi(denied.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, denied.deps)).rejects.toBeInstanceOf(DBusError);
		expect(denied.writes).toHaveLength(0);
	});
	test.each([false, true])('a failed clone restores the original secret and autoconnect policy: active=%s', async active => {
		const f = wifiFixture({ active });
		f.state.failure = 'clone-activation';
		await expect(connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, f.deps)).rejects.toThrow('activation failed');
		expect(f.writes.map(call => call.member)).toEqual(['CheckpointCreate', 'AddAndActivateConnection2', 'CheckpointRollback', ...(active ? [] : ['Set'])]);
		expect(f.secrets.get(PROFILE)).toBe(OLD_PASSWORD);
		expect(f.state.autoconnect).toBe(active);
		if (!active) expect(f.writes[f.writes.length - 1]!.args).toEqual(['org.freedesktop.NetworkManager.Device', 'Autoconnect', variant('b', false)]);
		expect(f.state.active).toBe(active ? PROFILE : null);
		expect(f.profiles.size).toBe(1);
	});
	test('a disappearing volatile active connection is a failed activation, not an unsupported API', async () => {
		const f = wifiFixture();
		const read = f.deps.read;
		await expect(
			connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, {
				...f.deps,
				read: async (endpoint, request, timeout) => {
					if (request.path.includes('/ActiveConnection/')) return { type: 'error', sender: endpoint.rule.destination, signature: '', values: [], errorName: 'org.freedesktop.DBus.Error.UnknownMethod', errorMessage: 'Object no longer exists' };
					return read(endpoint, request, timeout);
				},
			})
		).rejects.toThrow('Wi-Fi activation failed before completion');
		expect(f.state.autoconnect).toBe(false);
		expect(f.writes.some(call => call.member === 'CheckpointRollback')).toBe(true);
	});
	test('a known failure after commit compensates the original secret before rollback', async () => {
		for (const failure of ['commit', 'original-activation']) {
			const f = wifiFixture();
			f.state.failure = failure;
			await expect(connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, f.deps)).rejects.toThrow();
			expect(f.writes.slice(-3).map(call => call.member)).toEqual(['Update2', 'CheckpointRollback', 'Set']);
			expect(f.secrets.get(PROFILE)).toBe(OLD_PASSWORD);
			expect(f.profiles.size).toBe(1);
			expect((await observeNativeLinuxWifi(f.records[f.records.length - 1], 5000, f.deps)).outcome).toBe('original');
		}
	});
	test('unknown commit, activation or compensation never starts another write', async () => {
		for (const unknown of ['Update2', 'ActivateConnection', 'compensation']) {
			const f = wifiFixture();
			f.state.unknown = unknown;
			if (unknown === 'compensation') f.state.failure = 'original-activation';
			await expect(connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, f.deps)).rejects.toBeInstanceOf(NativeMutationUnknown);
			expect(f.writes.some(call => call.member === 'CheckpointRollback')).toBe(false);
			expect(f.writes[f.writes.length - 1]!.member).toBe(unknown === 'ActivateConnection' ? 'ActivateConnection' : 'Update2');
		}
	});
	test('expired budget with an active clone stays pending without committing the password', async () => {
		const f = wifiFixture();
		f.state.expireAtCommit = true;
		await expect(connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, f.deps)).rejects.toBeInstanceOf(NativeMutationUnknown);
		expect(f.writes.map(call => call.member)).toEqual(['CheckpointCreate', 'AddAndActivateConnection2']);
		expect(f.state.pending).toBe(true);
		expect(f.secrets.get(PROFILE)).toBe(OLD_PASSWORD);
	});
	test('disconnect only deactivates and verifies the device, preserving saved profiles', async () => {
		const f = wifiFixture({ active: true });
		const before = structuredClone([...f.profiles]);
		await disconnectNativeLinuxWifi(f.context, 'wlan0', wifiOptions, f.deps);
		expect(f.writes.map(call => call.member)).toEqual(['Disconnect']);
		expect([...f.profiles]).toEqual(before);
		expect(f.reads.some(call => call.member === 'GetSecrets')).toBe(false);
		expect((await observeNativeLinuxWifi(f.records[f.records.length - 1], 5000, f.deps)).outcome).toBe('target');
	});
	test('a failed read after accepted Disconnect remains pending rather than claiming completion', async () => {
		const f = wifiFixture({ active: true });
		const read = f.deps.read;
		await expect(
			disconnectNativeLinuxWifi(f.context, 'wlan0', wifiOptions, {
				...f.deps,
				read: async (endpoint, request, timeout) => {
					if (f.writes.some(call => call.member === 'Disconnect')) throw new Error('Connection read failed');
					return read(endpoint, request, timeout);
				},
			})
		).rejects.toBeInstanceOf(NativeMutationUnknown);
		expect(f.state.pending).toBe(true);
		expect(f.writes.map(call => call.member)).toEqual(['Disconnect']);
	});
});

describe('Wi-Fi recovery after proven execution end', () => {
	test('an unknown clone UUID is detected by its operation-specific ID', async () => {
		const f = wifiFixture();
		f.state.unknown = 'AddAndActivateConnection2';
		await expect(connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, f.deps)).rejects.toBeInstanceOf(NativeMutationUnknown);
		const result = await observeNativeLinuxWifi(f.records[f.records.length - 1], 5000, f.deps);
		expect(result).toMatchObject({ cloneExists: true, originalMatches: false, targetMatches: false, outcome: 'different' });
	});
	test('profile UUID lookup tolerates object paths changing after a restart', async () => {
		const f = wifiFixture();
		await connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, f.deps);
		const newPath = `${ROOT}/Settings/7`;
		f.profiles.set(newPath, f.profiles.get(PROFILE)!);
		f.profiles.delete(PROFILE);
		f.secrets.set(newPath, f.secrets.get(PROFILE)!);
		f.secrets.delete(PROFILE);
		f.state.active = newPath;
		expect((await observeNativeLinuxWifi(f.records[f.records.length - 1], 5000, f.deps)).targetMatches).toBe(true);
	});
	test('an inactive original keeps a verified new password after checkpoint expiry and reports partial', async () => {
		const f = wifiFixture();
		f.state.unknown = 'ActivateConnection';
		await expect(connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, f.deps)).rejects.toThrow();
		f.autoRollback();
		const record = f.records[f.records.length - 1]!;
		expect(isWifiRecoveryData(record)).toBe(true);
		const result = await observeNativeLinuxWifi(record, 5000, f.deps);
		expect(result).toMatchObject({ outcome: 'password-committed', secretState: 'new', targetMatches: false, cloneExists: false });
	});
	test('an initially active profile restored by the checkpoint is reported as original', async () => {
		const f = wifiFixture({ active: true });
		f.state.unknown = 'ActivateConnection';
		await expect(connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, f.deps)).rejects.toThrow();
		f.autoRollback();
		expect((await observeNativeLinuxWifi(f.records[f.records.length - 1], 5000, f.deps)).outcome).toBe('original');
	});
	test('same old/new password still matches the target and does not imply a changed password', async () => {
		const f = wifiFixture();
		await connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', OLD_PASSWORD, BSSID, wifiOptions, f.deps);
		const result = await observeNativeLinuxWifi(f.records[f.records.length - 1], 5000, f.deps);
		expect(result).toMatchObject({ outcome: 'target', secretState: 'old' });
	});
	test('invalid records and a changed stored secret never report success', async () => {
		const f = wifiFixture();
		await connectNativeLinuxWifi(f.context, 'wlan0', 'Demo', NEW_PASSWORD, BSSID, wifiOptions, f.deps);
		const record = f.records[f.records.length - 1]!;
		expect(isWifiRecoveryData({ ...record, secretSalt: null })).toBe(false);
		expect(isWifiRecoveryData({ ...record, operation: 'disconnect' })).toBe(false);
		f.secrets.set(PROFILE, 'another-demo-password');
		expect((await observeNativeLinuxWifi(record, 5000, f.deps)).outcome).toBe('different');
		const changed = structuredClone(f.profiles.get(PROFILE)!);
		changed['ipv4']!['route-metric'] = variant('x', 50n);
		expect(wifiProfileFingerprint(changed)).not.toBe(record.desiredProfileFingerprint);
	});
});
