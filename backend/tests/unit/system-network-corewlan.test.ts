import { describe, expect, it } from 'bun:test';
import { associateMacWifi, macSecurityType, macSsidHex } from '../../src/system-network-corewlan.ts';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

function workerResult(name: 'selectCoreWlanTarget' | 'coreWlanSecurityType' | 'coreWlanNamesVisible' | 'coreWlanInterfaceState' | 'coreWlanScanRows' | 'coreWlanAssociationMatches', args: unknown[]): unknown {
	// Importing an asset as executable code in the same Bun loader aliases the module cache.
	const module = pathToFileURL(resolve(import.meta.dir, '../../src/system-network-corewlan-worker.js')).href;
	const script = `import { ${name} } from ${JSON.stringify(module)}; console.log(JSON.stringify(${name}(...${JSON.stringify(args)})));`;
	const result = Bun.spawnSync([process.execPath, '--eval', script]);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return JSON.parse(result.stdout.toString());
}

function selectCoreWlanTarget(networks: unknown[], ssidHex: string, securityType: number, bssid: string | null = null): unknown {
	return workerResult('selectCoreWlanTarget', [networks, ssidHex, securityType, bssid]);
}

describe('CoreWLAN security selection', () => {
	it.each([
		['', 0],
		['WPA Personal', 2],
		['WPA/WPA2 Personal', 3],
		['WPA2 Personal', 4],
		['WPA3 Personal', 11],
		['WPA2/WPA3 Personal', 13],
		['WPA3/WPA2 Personal', 13],
	])('matches the scanned %s security to the native enum', (label, value) => {
		expect(macSecurityType(label as string)).toBe(value);
	});

	it.each(['WEP', 'WPA2 Enterprise', 'OWE', 'WPA4 Personal', 'Unknown'])('rejects %s before attempting association', label => {
		expect(() => macSecurityType(label)).toThrow('not supported');
	});
});

describe('CoreWLAN worker', () => {
	it('rejects an SSID that cannot be represented by its original 32 bytes', () => {
		expect(() => associateMacWifi('en0', 'é'.repeat(17), 'password', 'WPA2 Personal')).toThrow('cannot identify');
	});

	it('retains non-UTF-8 SSID bytes without encoding the display replacement character', () => {
		expect(macSsidHex('\ufffd', 'ff')).toBe('ff');
		expect(macSsidHex('\ufffd'.repeat(32), 'ff'.repeat(32))).toBe('ff'.repeat(32));
		expect(() => macSsidHex('Different network', 'ff')).toThrow('cannot identify');
		expect(() => macSsidHex('Network', 'f')).toThrow('cannot identify');
	});

	it('rejects a password for an open target before entering the worker', () => {
		expect(() => associateMacWifi('en0', 'Open network', 'secret', '')).toThrow('does not accept a password');
	});

	it('reports a missing native interface without disclosing the password', async () => {
		const secret = 'test-key-never-in-argv';
		const failure = await associateMacWifi('libershare-no-such-interface', 'Test network', secret, 'WPA2 Personal').catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).not.toContain(secret);
		expect((failure as Error).message).toBe(process.platform === 'darwin' ? 'macOS Wi-Fi interface is unavailable' : 'CoreWLAN is only available on macOS');
	}, 30_000);
});

describe('CoreWLAN scan identity', () => {
	const hex = Buffer.from('Test network').toString('hex');
	const weak = { network: 1, ssidHex: hex, securityType: 4, signal: -70 };
	const strong = { network: 2, ssidHex: hex, securityType: 4, signal: -40 };

	it('chooses the strongest native network object for equivalent access points', () => {
		expect(selectCoreWlanTarget([weak, strong], hex, 4)).toBe(2);
	});

	it('rejects a changed security mode even when one access point still matches', () => {
		expect(() => selectCoreWlanTarget([weak, { ...strong, securityType: 0 }], hex, 4)).toThrow('ambiguous');
		expect(() => selectCoreWlanTarget([{ ...weak, securityType: 13 }], hex, 4)).toThrow('security changed');
	});

	it('rejects redacted or different raw SSID bytes', () => {
		expect(() => selectCoreWlanTarget([{ ...weak, ssidHex: undefined }], hex, 4)).toThrow('cannot identify');
		expect(() => selectCoreWlanTarget([{ ...weak, ssidHex: 'ff' }], hex, 4)).toThrow('cannot identify');
	});

	it('does not treat an empty scan as an accepted association', () => {
		expect(() => selectCoreWlanTarget([], hex, 4)).toThrow('no longer available');
	});

	it('pins an explicit BSSID while ignoring other same-name access points', () => {
		const selected = { ...weak, bssid: '02:00:00:00:00:aa' };
		const other = { ...strong, bssid: '02:00:00:00:00:bb', securityType: 0 };
		expect(selectCoreWlanTarget([selected, other], hex, 4, '02:00:00:00:00:AA')).toBe(1);
		expect(() => selectCoreWlanTarget([other], hex, 4, selected.bssid)).toThrow('no longer available');
		expect(() => selectCoreWlanTarget([selected, selected], hex, 4, selected.bssid)).toThrow('ambiguous');
		expect(() => selectCoreWlanTarget([{ ...selected, securityType: 0 }], hex, 4, selected.bssid)).toThrow('security changed');
	});
});

describe('CoreWLAN native state', () => {
	const snapshot = { device: 'en0', ssidHex: Buffer.from('Office').toString('hex'), powerOn: true, signal: -65 };

	it('uses actual SSID readability for connected, idle, denied and powered-off radios', () => {
		expect(workerResult('coreWlanNamesVisible', [snapshot])).toBe(true);
		expect(workerResult('coreWlanNamesVisible', [{ ...snapshot, ssidHex: null }, [{ ssidHex: 'ff' }]])).toBe(true);
		expect(workerResult('coreWlanNamesVisible', [{ ...snapshot, ssidHex: null }, [{ ssidHex: null }]])).toBe(false);
		expect(workerResult('coreWlanNamesVisible', [{ ...snapshot, ssidHex: null }, []])).toBe(false);
		expect(workerResult('coreWlanNamesVisible', [{ ...snapshot, powerOn: false }, [{ ssidHex: 'ff' }]])).toBe(false);
	});

	it('shows native names after a grant and clears them on revocation', () => {
		expect(workerResult('coreWlanInterfaceState', [snapshot, true])).toEqual({ device: 'en0', configurable: true, wifi: { ssid: 'Office', signal: 70, radio: 'on' } });
		expect(workerResult('coreWlanInterfaceState', [snapshot, false])).toEqual({ device: 'en0', configurable: false, wifi: { ssid: null, signal: 70, radio: 'on' } });
	});

	it('keeps an idle radio configurable and marks a powered-off radio unavailable', () => {
		expect(workerResult('coreWlanInterfaceState', [{ ...snapshot, ssidHex: null, signal: 0 }, true])).toEqual({ device: 'en0', configurable: true, wifi: { ssid: null, signal: null, radio: 'on' } });
		expect(workerResult('coreWlanInterfaceState', [{ ...snapshot, powerOn: false }, true])).toEqual({ device: 'en0', configurable: false, wifi: { ssid: null, signal: null, radio: 'off' } });
	});
});

describe('CoreWLAN scan presentation', () => {
	const joined = { ssidHex: 'ff', bssid: '02:00:00:00:00:01', securityType: 4, signal: -65 };

	it('keeps raw identities distinct even when their display names decode identically', () => {
		expect(workerResult('coreWlanScanRows', [[joined, { ...joined, ssidHex: 'fe', bssid: '02:00:00:00:00:02' }], {}])).toMatchObject([
			{ ssid: '\ufffd', ssidHex: 'ff', bssid: joined.bssid, connectable: true },
			{ ssid: '\ufffd', ssidHex: 'fe', bssid: '02:00:00:00:00:02', connectable: true },
		]);
	});

	it('marks only the matching security and BSSID active but blocks every current-SSID rejoin', () => {
		expect(workerResult('coreWlanScanRows', [[joined, { ...joined, bssid: '02:00:00:00:00:02' }, { ...joined, securityType: 0 }], joined])).toMatchObject([
			{ active: true, connectable: false, unavailableReason: 'This interface is already connected to this SSID' },
			{ active: false, connectable: false },
			{ active: false, connectable: false },
		]);
	});

	it('drops withheld SSIDs while keeping unsupported security visible', () => {
		expect(
			workerResult('coreWlanScanRows', [
				[
					{ ...joined, ssidHex: null },
					{ ...joined, securityType: -1 },
				],
				{},
			])
		).toMatchObject([{ supported: false, secured: true, security: 'Unsupported', signal: 70 }]);
	});

	it('recognizes a transition AP associated through its WPA2 constituent', () => {
		expect(workerResult('coreWlanScanRows', [[{ ...joined, securityType: 13 }], joined])).toMatchObject([{ active: true, connectable: false }]);
	});
});

describe('CoreWLAN final association verification', () => {
	const actual = { ssidHex: 'ff', bssid: '02:00:00:00:00:01', securityType: 4 };

	it.each([
		[0, 0, true],
		[4, 4, true],
		[11, 11, true],
		[4, 0, false],
		[4, 11, false],
		[11, 4, false],
		[3, 2, true],
		[3, 4, true],
		[3, 0, false],
		[13, 4, true],
		[13, 11, true],
		[13, 0, false],
		[13, 2, false],
	])('verifies advertised %i against negotiated %i', (expected, negotiated, matches) => {
		expect(workerResult('coreWlanAssociationMatches', [{ ...actual, securityType: negotiated }, actual.ssidHex, actual.bssid, expected])).toBe(matches);
	});

	it('requires the selected raw SSID and access point as well as authentication', () => {
		expect(workerResult('coreWlanAssociationMatches', [actual, 'fe', actual.bssid, 4])).toBe(false);
		expect(workerResult('coreWlanAssociationMatches', [actual, 'ff', '02:00:00:00:00:02', 4])).toBe(false);
	});
});

describe('CoreWLAN security capabilities', () => {
	it.each([
		[[3, 4, 13], 4],
		[[3, 4, 11, 13], 13],
		[[2, 3], 2],
		[[2, 3, 4, 13], 3],
		[[11, 13], 11],
		[[0], 0],
		[[9], -1],
		[[14], -1],
	])('classifies native capabilities %j as security %i', (flags, expected) => {
		expect(workerResult('coreWlanSecurityType', [flags])).toBe(expected);
	});
});
