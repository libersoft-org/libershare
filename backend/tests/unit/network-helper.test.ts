import { describe, expect, it } from 'bun:test';
import { decodeNetworkHelperRequest, encodeNetworkHelperRequest, executeNetworkHelperRequest, parseNetworkHelperResponse } from '../../src/network-helper-protocol.ts';
import { linuxNetworkHelperArgs, MAC_HELPER_SHELL, macAppBundleRoot, macNetworkHelperScript, networkHelperPath, trustedLinuxHelperMetadata, windowsNetworkHelperCommand } from '../../src/network-helper-client.ts';

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
		const result = await executeNetworkHelperRequest(request, async (interfaceID, config) => {
			calls.push({ interfaceID, config });
			return { interfaces: [], primaryID: null, detail: 'full', known: true, capabilities: { ipv4: true, wifi: false, staticGatewayRequired: false } };
		});
		expect(calls).toEqual([{ interfaceID: 'eth0', config: { mode: 'dhcp' } }]);
		expect(result).toEqual({ ok: true });
		expect(parseNetworkHelperResponse(JSON.stringify(result))).toEqual(result);
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
});

describe('network helper launch commands', () => {
	const request = 'eyJ2ZXJzaW9uIjoxfQ';

	it('passes only a fixed helper path and encoded request on Windows', () => {
		const command = windowsNetworkHelperCommand('C:\\Program Files\\LiberShare\\lish-network-helper.exe', request, '\\\\.\\pipe\\lish-network-helper-0123456789abcdef0123456789abcdef0123456789abcdef');
		expect(command).toContain('-Verb RunAs');
		expect(command).toContain('-UseNewEnvironment');
		expect(command).toContain('lish-network-helper.exe');
		expect(command).toContain(request);
		expect(command).toContain('--response-pipe');
		expect(command).not.toContain('RedirectStandardOutput');
		expect(command).not.toContain('Invoke-Expression');
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
