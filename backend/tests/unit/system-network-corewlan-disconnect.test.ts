import { describe, expect, it } from 'bun:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { disconnectMacWifi } from '../../src/system-network-macos.ts';

function disconnectScenario(mode: string): { error: string | null; writes: number; reads: number; phase: number; result: string } {
	const module = pathToFileURL(resolve(import.meta.dir, '../../src/system-network-corewlan-worker.js')).href;
	const script = `
		import { disconnectCoreWlanInterface } from ${JSON.stringify(module)};
		const phase = new Int32Array(new SharedArrayBuffer(4));
		const mode = ${JSON.stringify(mode)};
		if (mode === 'cancelled') phase[0] = 2;
		let writes = 0, reads = 0, error = null, result;
		Atomics.wait = () => 'timed-out';
		const connected = { interfaceMode: 1, ssidHex: '54657374', bssid: '02:00:00:00:00:01' };
		const disconnected = { interfaceMode: 0, ssidHex: null, bssid: null };
		try {
			result = disconnectCoreWlanInterface(phase, () => {
				if (phase[0] !== 1) throw new Error('write without phase protection');
				writes++;
				if (mode === 'native-error') throw new Error('native failure');
			}, () => {
				reads++;
				if (mode === 'already-disconnected') return disconnected;
				if (mode === 'access-point') return { ...connected, interfaceMode: 3 };
				if (reads === 1 || mode === 'still-connected') return connected;
				if (mode === 'redacted') return { ...disconnected, interfaceMode: 1 };
				if (mode === 'stale-ssid') return { ...disconnected, ssidHex: connected.ssidHex };
				if (mode === 'stale-bssid') return { ...disconnected, bssid: connected.bssid };
				if (mode === 'delayed' && reads < 4) return connected;
				return disconnected;
			});
		} catch (failure) { error = failure.message; }
		console.log(JSON.stringify({ error, writes, reads, phase: phase[0], result: String(result) }));
	`;
	const child = Bun.spawnSync([process.execPath, '--eval', script], { timeout: 5000 });
	if (child.exitCode !== 0) throw new Error(child.stderr.toString());
	return JSON.parse(child.stdout.toString());
}

describe('CoreWLAN disconnect', () => {
	it.each(['success', 'delayed'])('confirms %s disconnection after entering the mutation phase', mode => {
		const result = disconnectScenario(mode);
		expect(result.error).toBeNull();
		expect(result.writes).toBe(1);
		expect(result.phase).toBe(1);
		expect(result.reads).toBe(mode === 'delayed' ? 4 : 2);
		expect(result.result).toBe('undefined');
	});

	it.each(['still-connected', 'redacted', 'stale-ssid', 'stale-bssid'])('does not report success for %s state', mode => {
		const result = disconnectScenario(mode);
		expect(result.error).toContain('did not confirm');
		expect(result.writes).toBe(1);
		expect(result.reads).toBe(51);
	});

	it.each(['already-disconnected', 'access-point', 'cancelled'])('does not issue a native write for %s', mode => {
		const result = disconnectScenario(mode);
		expect(result.error).not.toBeNull();
		expect(result.writes).toBe(0);
	});

	it('propagates a native disconnect failure', () => {
		const result = disconnectScenario('native-error');
		expect(result.error).toBe('native failure');
		expect(result.writes).toBe(1);
	});

	it('rejects a missing native interface through the platform export', async () => {
		await expect(disconnectMacWifi('libershare-no-such-interface')).rejects.toThrow(process.platform === 'darwin' ? 'interface is unavailable' : 'only available on macOS');
	});
});
