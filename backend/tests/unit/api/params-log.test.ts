import { describe, it, expect } from 'bun:test';
import { canAdministerHostNetwork, formatParamsForLog, networkStateForClient } from '../../../src/api/api.ts';

describe('formatParamsForLog', () => {
	it('leaves a small params object intact', () => {
		expect(formatParamsForLog({ path: '/tmp/a.lish' })).toBe('{"path":"/tmp/a.lish"}');
	});

	it('truncates a file-sized base64 upload instead of logging all of it', () => {
		const line = formatParamsForLog({ data: 'A'.repeat(2 * 1024 * 1024), fileName: 'a.lish.gz' });
		expect(line.length).toBeLessThan(1100);
		expect(line).toContain('chars)');
	});

	it('renders missing params instead of the empty string', () => {
		expect(formatParamsForLog(undefined)).toBe('undefined');
	});

	it('redacts secrets at every nesting level', () => {
		const line = formatParamsForLog({
			interfaceID: 'wlan0',
			ssid: 'Example network',
			password: 'wifi-secret',
			nested: { apiToken: 'api-secret', passphrase: 'other-secret' },
		});

		expect(line).toContain('"interfaceID":"wlan0"');
		expect(line).toContain('"ssid":"Example network"');
		expect(line).not.toContain('wifi-secret');
		expect(line).not.toContain('api-secret');
		expect(line).not.toContain('other-secret');
		expect(line.match(/\[REDACTED\]/g)).toHaveLength(3);
	});
});

describe('host network administration trust boundary', () => {
	it('requires both API authentication and a browser on the same host', () => {
		expect(canAdministerHostNetwork(true, true)).toBe(true);
		expect(canAdministerHostNetwork(true, false)).toBe(false);
		expect(canAdministerHostNetwork(false, true)).toBe(false);
	});

	it('removes write capabilities from network state sent to a remote client', () => {
		const state = {
			interfaces: [],
			primaryID: null,
			detail: 'full' as const,
			known: true,
			capabilities: { ipv4: true, wifi: true, staticGatewayRequired: false },
		};
		expect(networkStateForClient(state, true, true).capabilities).toEqual(state.capabilities);
		expect(networkStateForClient(state, true, false).capabilities).toEqual({ ipv4: false, ipv4Elevation: false, wifi: false, staticGatewayRequired: false });
	});
});
