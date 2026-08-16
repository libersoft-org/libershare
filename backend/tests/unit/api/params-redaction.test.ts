import { describe, it, expect } from 'bun:test';
import { formatParamsForLog } from '../../../src/api/api.ts';

/**
 * The API logs every call with its parameters. Joining a Wi-Fi network sends the
 * passphrase through that same path, and the log is a file that outlives the call
 * and ends up in bug reports — so the value must never be written.
 */
describe('formatParamsForLog', () => {
	it('withholds a Wi-Fi passphrase but keeps the call recognisable', () => {
		const line = formatParamsForLog({ interfaceID: 'wlan0', ssid: 'Example Net', password: 'correct horse battery staple' });
		expect(line).not.toContain('correct horse battery staple');
		expect(line).toContain('"password":"<redacted>"');
		expect(line).toContain('wlan0');
	});

	it('withholds the other secret-carrying names too', () => {
		const line = formatParamsForLog({ passphrase: 'a', token: 'b', secret: 'c' });
		expect(line).toBe('{"passphrase":"<redacted>","token":"<redacted>","secret":"<redacted>"}');
	});

	it('leaves ordinary parameters untouched', () => {
		expect(formatParamsForLog({ lishID: 'abc', enabled: true, count: 3 })).toBe('{"lishID":"abc","enabled":true,"count":3}');
	});

	it('redacts a secret nested inside the params', () => {
		expect(formatParamsForLog({ config: { password: 'hunter2' } })).toBe('{"config":{"password":"<redacted>"}}');
	});

	// The log runs before the handler, so it sees whatever shape the client sent.
	// A passphrase smuggled in as an array or an object used to be logged in full
	// because only a string value was replaced.
	it('withholds a secret sent as an array', () => {
		const line = formatParamsForLog({ interfaceID: 'wlan0', password: ['correct horse battery staple'] });
		expect(line).not.toContain('correct horse battery staple');
		expect(line).toContain('"password":"<redacted>"');
	});

	it('withholds a secret sent as an object', () => {
		const line = formatParamsForLog({ password: { value: 'correct horse battery staple' } });
		expect(line).not.toContain('correct horse battery staple');
	});

	it('withholds a secret sent as a number', () => {
		expect(formatParamsForLog({ password: 12345678 })).toBe('{"password":"<redacted>"}');
	});
});
