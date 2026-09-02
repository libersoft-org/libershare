import { describe, expect, it } from 'bun:test';
import { CodedError, ErrorCodes } from '@shared';
import { decodeNetworkHelperRequest, encodeNetworkHelperRequest, executeNetworkHelperRequest, NETWORK_HELPER_EXIT, networkHelperExitCode, networkHelperFailure, parseNetworkHelperResponse } from '../../src/network-helper-protocol.ts';
import { HELPER_TIMEOUT_MS, linuxNetworkHelperArgs, MAC_HELPER_SHELL, macAppBundleRoot, macNetworkHelperScript, networkHelperPath, trustedLinuxHelperMetadata, windowsLauncherFailure, windowsNetworkLauncherPath } from '../../src/network-helper-client.ts';
import { NETWORK_MANAGER_CHECKPOINT_TIMEOUT_SECONDS } from '../../src/system-network-linux.ts';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { windowsHelperParameters, WINDOWS_LAUNCHER_EXIT, windowsPowerShellPath, windowsProgramFilesPath, windowsRequestFileHeld, windowsSystemEnvironment, writeWindowsRequestFile } from '../../src/network-helper-windows.ts';

describe('network helper protocol', () => {
	it('round-trips one validated IPv4 operation', () => {
		const request = { version: 1 as const, operation: 'applyIPv4' as const, interfaceID: 'eth0', config: { mode: 'static' as const, address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['192.0.2.53'] } };
		expect(decodeNetworkHelperRequest(encodeNetworkHelperRequest(request))).toEqual(request);
	});

	it('rejects unknown operations, unsafe interfaces, and invalid network data', () => {
		for (const request of [
			{ version: 1, operation: 'shell', interfaceID: 'eth0', config: { mode: 'dhcp' } },
			{ version: 1, operation: 'applyIPv4', interfaceID: 'bad\nname', config: { mode: 'dhcp' } },
			{ version: 1, operation: 'applyIPv4', interfaceID: 'eth0', config: { mode: 'static', address: '0.0.0.0', prefixLength: 24 } },
		]) {
			const encoded = Buffer.from(JSON.stringify(request)).toString('base64url');
			expect(() => decodeNetworkHelperRequest(encoded)).toThrow();
		}
	});

	it('dispatches only the typed apply operation', async () => {
		const calls: unknown[] = [];
		const request = decodeNetworkHelperRequest(encodeNetworkHelperRequest({ version: 1, operation: 'applyIPv4', interfaceID: 'eth0', config: { mode: 'dhcp' } }));
		const result = await executeNetworkHelperRequest(request, async (interfaceID, config, expected) => {
			calls.push({ interfaceID, config, expected });
			return { interfaces: [], primaryID: null, detail: 'full', known: true, capabilities: { ipv4: true, wifi: false, staticGatewayRequired: false } };
		});
		expect(calls).toEqual([{ interfaceID: 'eth0', config: { mode: 'dhcp' }, expected: undefined }]);
		expect(result).toEqual({ ok: true });
		expect(parseNetworkHelperResponse(JSON.stringify(result))).toEqual(result);
	});

	it('carries the baseline the change was built on into the privileged apply', async () => {
		// The authorization prompt can stay open for a long time; the helper must
		// re-check the baseline against its own fresh read, so it has to receive it.
		const expected = { mode: 'static' as const, address: '192.0.2.10', prefixLength: 24, gateway: '192.0.2.1', dns: ['192.0.2.53'] };
		const request = decodeNetworkHelperRequest(encodeNetworkHelperRequest({ version: 1, operation: 'applyIPv4', interfaceID: 'eth0', config: { mode: 'dhcp' }, expected }));
		expect(request.expected).toEqual(expected);
		const seen: unknown[] = [];
		await executeNetworkHelperRequest(request, async (_interfaceID, _config, baseline) => {
			seen.push(baseline);
			return null;
		});
		expect(seen).toEqual([expected]);
	});

	it('outlives the longest NetworkManager transaction it may have to wait for', () => {
		// Killing the helper before the checkpoint window closes would abandon a
		// rollback in progress and publish a state that is still changing.
		expect(HELPER_TIMEOUT_MS).toBeGreaterThan(NETWORK_MANAGER_CHECKPOINT_TIMEOUT_SECONDS * 1000);
	});

	it('rejects a baseline that is not exactly the shape the backend builds', () => {
		const base = { version: 1, operation: 'applyIPv4', interfaceID: 'eth0', config: { mode: 'dhcp' } };
		for (const expected of [null, [], 'x', { mode: 'static' }, { mode: 'bogus', address: null, prefixLength: null, gateway: null, dns: [] }, { mode: 'dhcp', address: null, prefixLength: null, gateway: null, dns: [], extra: 1 }, { mode: 'dhcp', address: 'x'.repeat(65), prefixLength: null, gateway: null, dns: [] }, { mode: 'dhcp', address: null, prefixLength: 33, gateway: null, dns: [] }, { mode: 'dhcp', address: null, prefixLength: null, gateway: null, dns: 'nope' }, { mode: 'dhcp', address: null, prefixLength: null, gateway: null, dns: [1] }]) {
			expect(() => decodeNetworkHelperRequest(Buffer.from(JSON.stringify({ ...base, expected })).toString('base64url'))).toThrow('baseline');
		}
	});

	it('rejects extra request fields and malformed helper responses', () => {
		const extra = Buffer.from(JSON.stringify({ version: 1, operation: 'applyIPv4', interfaceID: 'eth0', config: { mode: 'dhcp' }, command: 'whoami' })).toString('base64url');
		expect(() => decodeNetworkHelperRequest(extra)).toThrow();
		for (const response of ['{"ok":true,"state":{}}', '{"ok":false,"error":"bad\\nline"}', '{"ok":true,"extra":1}', 'x'.repeat(4097)]) expect(() => parseNetworkHelperResponse(response)).toThrow();
	});

	it('returns a bounded error instead of leaking a stack trace', async () => {
		const request = decodeNetworkHelperRequest(encodeNetworkHelperRequest({ version: 1, operation: 'applyIPv4', interfaceID: 'eth0', config: { mode: 'dhcp' } }));
		const result = await executeNetworkHelperRequest(request, async () => {
			throw new Error('x'.repeat(2000));
		});
		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error('expected failure');
		expect(result.error.length).toBeLessThanOrEqual(500);
		expect(result.error).not.toContain('network-helper.test.ts');
	});

	it('carries the stale-form refusal back across the privilege boundary', async () => {
		// The screen reloads the form only on this exact code; a generic failure
		// would let the same stale values be saved on the next attempt.
		const request = decodeNetworkHelperRequest(encodeNetworkHelperRequest({ version: 1, operation: 'applyIPv4', interfaceID: 'eth0', config: { mode: 'dhcp' } }));
		const stale = await executeNetworkHelperRequest(request, async () => {
			throw new CodedError(ErrorCodes.NETCONFIG_STALE, 'interface configuration changed since the form was opened');
		});
		expect(stale).toMatchObject({ ok: false, code: 'NETCONFIG_STALE' });
		if (stale.ok) throw new Error('expected failure');
		expect(stale.error).toContain('changed since the form was opened');
		expect(parseNetworkHelperResponse(JSON.stringify(stale))).toEqual(stale);
		expect(networkHelperExitCode(stale)).toBe(NETWORK_HELPER_EXIT.stale);
		expect(networkHelperExitCode({ ok: false, error: 'x' })).toBe(NETWORK_HELPER_EXIT.rejected);
		expect(networkHelperExitCode({ ok: true })).toBe(NETWORK_HELPER_EXIT.applied);
		const failure = windowsLauncherFailure(NETWORK_HELPER_EXIT.stale);
		expect(failure.code).toBe('NETCONFIG_STALE');
		const foreign = await executeNetworkHelperRequest(request, async () => {
			throw new CodedError(ErrorCodes.INTERNAL_ERROR, 'not a network code');
		});
		expect(foreign).toEqual({ ok: false, error: 'INTERNAL_ERROR: not a network code' });
		for (const text of ['{"ok":false,"error":"x","code":"INTERNAL_ERROR"}', '{"ok":false,"error":"x","code":1}', '{"ok":true,"code":"NETCONFIG_STALE"}']) expect(() => parseNetworkHelperResponse(text)).toThrow();
	});

	it('shapes a decode failure into the same bounded response as an apply failure', () => {
		// A request that never decodes must not escape as a runtime stack trace:
		// on Linux the helper's stderr is what the UI shows as the reason.
		let thrown: unknown;
		try {
			decodeNetworkHelperRequest(Buffer.from(JSON.stringify({ version: 1, operation: 'shell', interfaceID: 'eth0', config: { mode: 'dhcp' } })).toString('base64url'));
		} catch (error) {
			thrown = error;
		}
		const response = networkHelperFailure(thrown);
		expect(response).toEqual({ ok: false, error: 'unsupported network helper operation' });
		expect(parseNetworkHelperResponse(JSON.stringify(response))).toEqual(response);
		expect(networkHelperFailure(new Error(`bad\nline${'x'.repeat(900)}`)).ok).toBe(false);
		expect(networkHelperFailure(new Error('')).error).toBe('network change failed');
	});
});

describe('windows launcher outcomes', () => {
	it('tells a cancelled prompt apart from a failed change', () => {
		expect(windowsLauncherFailure(WINDOWS_LAUNCHER_EXIT.cancelled).error).toContain('cancelled');
		expect(windowsLauncherFailure(WINDOWS_LAUNCHER_EXIT.timeout).error).toContain('timed out');
		expect(windowsLauncherFailure(WINDOWS_LAUNCHER_EXIT.untrusted).error).toContain('not trusted');
		expect(windowsLauncherFailure(NETWORK_HELPER_EXIT.rejected).error).toContain('could not apply');
	});

	it('falls back to one generic reason for an unmapped or absent exit code', () => {
		for (const code of [null, undefined, 1, 255, 'boom']) expect(windowsLauncherFailure(code)).toEqual({ ok: false, error: 'the privileged network helper failed' });
	});

	it('reserves launcher codes that cannot collide with the helper', () => {
		// 0 = applied and 10 = helper rejected the change both come from the helper
		// itself, so the launcher's own reasons must live outside that set.
		for (const helperCode of Object.values(NETWORK_HELPER_EXIT)) expect(Object.values(WINDOWS_LAUNCHER_EXIT)).not.toContain(helperCode);
		expect(new Set(Object.values(WINDOWS_LAUNCHER_EXIT)).size).toBe(3);
	});
});

describe('network helper launch commands', () => {
	const request = 'eyJ2ZXJzaW9uIjoxfQ';

	it('hands the Windows helper one readable file path instead of an encoded request', () => {
		// UAC shows this command line to the user under "Program location".
		const file = 'C:\\Users\\alice\\AppData\\Local\\LiberShare\\network-request.json';
		expect(windowsHelperParameters(file)).toBe(`--request-file "${file}"`);
		expect(windowsHelperParameters(file)).not.toContain(request);
		expect(() => windowsHelperParameters(`${file}" --request ${request}`)).toThrow();
		expect(() => windowsHelperParameters('network-request.json')).toThrow();
		expect(() => windowsHelperParameters(`C:\\x\n.json`)).toThrow();
	});

	it('freezes the request file until the launcher releases it', () => {
		if (process.platform !== 'win32') return;
		const path = join(tmpdir(), `lish-request-${process.pid}.json`);
		const guard = writeWindowsRequestFile(path, '{"version":1}');
		try {
			expect(() => writeFileSync(path, 'tampered')).toThrow();
			expect(() => unlinkSync(path)).toThrow();
			expect(readFileSync(path, 'utf8')).toBe('{"version":1}');
			// The same lock is what tells the elevated helper its launcher is still
			// waiting for the answer.
			expect(windowsRequestFileHeld(path)).toBe(true);
		} finally {
			guard.release();
		}
		expect(existsSync(path)).toBe(false);
	});

	it('reports a request file nobody holds any more', () => {
		if (process.platform !== 'win32') return;
		// UAC leaves its prompt on screen after the launcher is killed, and the file
		// it left behind is unprotected. Approving that prompt must not apply a
		// change the backend already gave up on.
		const path = join(tmpdir(), `lish-orphan-${process.pid}.json`);
		writeFileSync(path, '{"version":1}');
		try {
			expect(windowsRequestFileHeld(path)).toBe(false);
		} finally {
			unlinkSync(path);
		}
		expect(windowsRequestFileHeld(path)).toBe(false);
	});

	it('reads Program Files through the Windows known-folder API', () => {
		if (process.platform === 'win32') {
			expect(windowsProgramFilesPath()).toMatch(/^[A-Z]:\\/i);
			expect(windowsPowerShellPath()).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
			const env = windowsSystemEnvironment();
			expect(env['PATH']).not.toContain(process.cwd());
			expect(env['PSModulePath']).toBeUndefined();
		} else expect(() => windowsProgramFilesPath()).toThrow('unavailable');
	});

	it('uses the system authorization dialog on macOS', () => {
		const script = macNetworkHelperScript();
		expect(script).toContain('with administrator privileges');
		expect(script).toContain('quoted form of helperPath');
		expect(script).toContain('quoted form of shellProgram');
		expect(script).not.toContain(request);
		expect(MAC_HELPER_SHELL).toContain('/usr/bin/codesign --verify --strict');
		expect(MAC_HELPER_SHELL).toContain('TeamIdentifier=');
		expect(MAC_HELPER_SHELL).toContain('Identifier=');
		expect(MAC_HELPER_SHELL).toContain('/usr/bin/shasum -a 256');
		expect(MAC_HELPER_SHELL).toContain('/usr/bin/mktemp -d /private/var/tmp/');
	});

	it('uses pkexec with a fixed executable and stdin on Linux', () => {
		expect(linuxNetworkHelperArgs('/opt/libershare/lish-network-helper')).toEqual(['/opt/libershare/lish-network-helper', '--stdin']);
	});

	it('never resolves a Linux helper from the application directory', () => {
		expect(networkHelperPath('linux', '/tmp/.mount_LiberShare/lish-backend')).toBe('/usr/libexec/libershare/lish-network-helper');
		expect(networkHelperPath('win32', 'C:\\Program Files\\LiberShare\\lish-backend.exe')).toBe('C:\\Program Files\\LiberShare\\lish-network-helper.exe');
		expect(windowsNetworkLauncherPath('C:\\Program Files\\LiberShare\\lish-backend.exe')).toBe('C:\\Program Files\\LiberShare\\lish-network-launcher.exe');
	});

	it('accepts only a root-owned regular Linux helper without group or other writes', () => {
		expect(trustedLinuxHelperMetadata(0, 0o100755, true)).toBe(true);
		expect(trustedLinuxHelperMetadata(1000, 0o100755, true)).toBe(false);
		expect(trustedLinuxHelperMetadata(0, 0o100775, true)).toBe(false);
		expect(trustedLinuxHelperMetadata(0, 0o100755, false)).toBe(false);
	});

	it('recognises only system Applications bundles on macOS', () => {
		expect(macAppBundleRoot('/Applications/LiberShare.app/Contents/Resources/lish-network-helper')).toBe('/Applications/LiberShare.app');
		expect(macAppBundleRoot('/Users/alice/Applications/LiberShare.app/Contents/Resources/lish-network-helper')).toBeNull();
		expect(macAppBundleRoot('/tmp/LiberShare.app/Contents/Resources/lish-network-helper')).toBeNull();
	});
});
