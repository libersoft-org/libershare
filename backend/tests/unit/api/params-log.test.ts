import { describe, it, expect } from 'bun:test';
import { canAdministerHostNetwork, formatParamsForLog } from '../../../src/api/api.ts';

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
	it('allows local clients and authenticated remote API deployments only', () => {
		const local = new Set(['192.0.2.10']);
		expect(canAdministerHostNetwork('192.0.2.10', false, local)).toBe(true);
		expect(canAdministerHostNetwork('198.51.100.20', true, local)).toBe(true);
		expect(canAdministerHostNetwork('198.51.100.20', false, local)).toBe(false);
	});

	it('re-evaluates local administration against the current host addresses', () => {
		const clientIP = '192.0.2.10';
		expect(canAdministerHostNetwork(clientIP, false, new Set([clientIP]))).toBe(true);
		expect(canAdministerHostNetwork(clientIP, false, new Set(['192.0.2.11']))).toBe(false);
	});
});
