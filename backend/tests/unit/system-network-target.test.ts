import { describe, expect, it } from 'bun:test';
import type { NetWifiNetwork } from '@shared';
import { resolveJoinTarget } from '../../src/system-network.ts';

describe('resolveJoinTarget with scanned BSSIDs', () => {
	const open: NetWifiNetwork = { ssid: 'Guests', bssid: '02:00:00:00:00:01', signal: 60, secured: false, security: '', supported: true, active: false };
	const secured: NetWifiNetwork = { ...open, bssid: '02:00:00:00:00:02', secured: true, security: 'WPA2' };

	it('refuses a name-only request for differently secured networks in either scan order', () => {
		expect(resolveJoinTarget([open, secured], 'Guests', null)).toBe('ambiguous');
		expect(resolveJoinTarget([secured, open], 'Guests', null)).toBe('ambiguous');
	});

	it('requires a selection even when both access points advertise the same security', () => {
		const second = { ...open, bssid: '02:00:00:00:00:03' };
		expect(resolveJoinTarget([open, second], 'Guests', null)).toBe('ambiguous');
	});

	it('uses the requested BSSID regardless of scan order', () => {
		expect(resolveJoinTarget([open, secured], 'Guests', secured.bssid)).toBe(secured);
		expect(resolveJoinTarget([secured, open], 'Guests', secured.bssid)).toBe(secured);
	});

	it('accepts an unambiguous name-only request and rejects a missing BSSID', () => {
		expect(resolveJoinTarget([secured], 'Guests', null)).toBe(secured);
		expect(resolveJoinTarget([open, secured], 'Guests', '02:00:00:00:00:99')).toBeNull();
	});
});
