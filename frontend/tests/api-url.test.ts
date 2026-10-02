import { describe, expect, test } from 'bun:test';
import { getAPIURL } from '../src/scripts/api-url.ts';

function browserWindow(protocol: string, host: string, search = ''): { location: { protocol: string; host: string; search: string } } {
	return {
		location: {
			protocol,
			host,
			search,
		},
	};
}

describe('getAPIURL', () => {
	test('uses same-origin WSS endpoint for HTTPS static frontend', () => {
		expect(getAPIURL({ window: browserWindow('https:', '192.0.2.9:6003') })).toBe('wss://192.0.2.9:6003/ws');
	});

	test('uses same-origin WS endpoint for HTTP static frontend', () => {
		expect(getAPIURL({ window: browserWindow('http:', 'localhost:6003') })).toBe('ws://localhost:6003/ws');
	});

	test('uses native IPC before any configured network endpoint', () => {
		expect(getAPIURL({ window: { ...browserWindow('https:', 'app.local:6003'), __BACKEND_IPC__: true }, viteBackendUrl: 'ws://example.test' })).toBe('ipc://backend');
	});

	test('keeps the dev backend query override', () => {
		expect(getAPIURL({ window: browserWindow('https:', 'localhost:6003', '?backend=ws://localhost:1159'), dev: true })).toBe('ws://localhost:1159');
	});

	test('uses VITE_BACKEND_URL when configured', () => {
		expect(getAPIURL({ window: browserWindow('https:', 'localhost:6003'), viteBackendUrl: 'wss://api.example/ws' })).toBe('wss://api.example/ws');
	});
});
