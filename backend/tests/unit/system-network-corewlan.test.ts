import { describe, expect, it } from 'bun:test';
import { associateMacWifi, macSecurityType } from '../../src/system-network-corewlan.ts';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

function workerResult(name: 'selectCoreWlanTarget' | 'coreWlanSecurityType', args: unknown[]): unknown {
	// Importing an asset as executable code in the same Bun loader aliases the module cache.
	const module = pathToFileURL(resolve(import.meta.dir, '../../src/system-network-corewlan-worker.js')).href;
	const script = `import { ${name} } from ${JSON.stringify(module)}; console.log(JSON.stringify(${name}(...${JSON.stringify(args)})));`;
	const result = Bun.spawnSync([process.execPath, '--eval', script]);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return JSON.parse(result.stdout.toString());
}

function selectCoreWlanTarget(networks: unknown[], ssidHex: string, securityType: number): unknown {
	return workerResult('selectCoreWlanTarget', [networks, ssidHex, securityType]);
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
