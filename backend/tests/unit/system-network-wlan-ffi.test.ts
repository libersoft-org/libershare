import { describe, expect, it } from 'bun:test';
import { FFIType } from 'bun:ffi';
import { isWindowsInterfaceID, readWindowsWifi, WLAN_SYMBOLS } from '../../src/system-network-windows.ts';

/**
 * The ABI of the WLAN client handle.
 *
 * Bun represents a pointer as a JavaScript number, and its FFI documentation
 * states that the Windows `HANDLE` type is not a virtual address and must be
 * declared `u64` rather than `ptr`. Every WLAN entry point but `WlanOpenHandle`
 * takes the handle as its first argument, so that is where the declaration is
 * checked; `WlanOpenHandle` receives a pointer to the caller's output buffer
 * instead and is the one function that legitimately declares `ptr` there.
 */
const HANDLE_FIRST = ['WlanCloseHandle', 'WlanEnumInterfaces', 'WlanQueryInterface', 'WlanScan', 'WlanGetAvailableNetworkList', 'WlanSetProfile', 'WlanGetProfile', 'WlanDeleteProfile', 'WlanGetProfileCustomUserData', 'WlanSetProfileCustomUserData', 'WlanConnect'] as const;

describe('WLAN_SYMBOLS', () => {
	it('declares every HANDLE parameter as u64 rather than ptr', () => {
		for (const name of HANDLE_FIRST) expect({ name, arg0: WLAN_SYMBOLS[name].args[0] }).toEqual({ name, arg0: FFIType.u64 });
	});

	// Deleting is the only way to undo a profile this app CREATED: writing back
	// "what was there before" would be writing nothing and leaving it standing.
	it('declares WlanDeleteProfile, without which a failed join cannot be undone', () => {
		expect(WLAN_SYMBOLS.WlanDeleteProfile.args).toEqual([FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr]);
	});

	// Windows keeps a per-profile blob other WLAN clients own and discards it on any
	// WlanSetProfile that changes the document — which every join does. Reading it
	// hands back a pointer the caller must free; writing it takes the length as a
	// plain DWORD, in the fourth position rather than through an out-parameter.
	it('declares the custom user data pair with the length by value', () => {
		expect(WLAN_SYMBOLS.WlanGetProfileCustomUserData.args).toEqual([FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr]);
		expect(WLAN_SYMBOLS.WlanSetProfileCustomUserData.args).toEqual([FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr]);
	});

	it('declares WlanReasonCodeToString with the code first, not a handle', () => {
		// The one entry point here that takes no client handle at all.
		expect(WLAN_SYMBOLS.WlanReasonCodeToString.args).toEqual([FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr]);
	});

	it('still declares the WlanOpenHandle output buffer as a pointer', () => {
		// PHANDLE really is an address — into our own BigUint64Array.
		expect(WLAN_SYMBOLS.WlanOpenHandle.args[3]).toBe(FFIType.ptr);
	});

	it('declares WlanFreeMemory as taking a real pointer', () => {
		expect(WLAN_SYMBOLS.WlanFreeMemory.args[0]).toBe(FFIType.ptr);
	});
});

/**
 * A live smoke test against the real wlanapi.dll. It opens a client handle,
 * enumerates the adapters, queries each one and closes the handle — the whole
 * read path — so a handle whose declared ABI does not match what the DLL expects
 * shows up here rather than on a user's machine.
 *
 * Read-only: nothing here scans, writes a profile or associates.
 */
describe.if(process.platform === 'win32')('readWindowsWifi against the live WLAN service', () => {
	it('completes a full open/enumerate/query/close cycle without throwing', () => {
		const result = readWindowsWifi();
		expect(result).toBeInstanceOf(Map);
	});

	it('keys every adapter it found by a canonical interface GUID', () => {
		// Empty on a host with no radio, which is a legitimate outcome; when there IS
		// one, a wrong handle or struct offset shows up as a malformed key.
		for (const [guid, info] of readWindowsWifi()) {
			expect(isWindowsInterfaceID(guid)).toBe(true);
			expect(['on', 'off', 'unknown']).toContain(info.radio);
			if (info.signal !== null) expect(info.signal).toBeLessThanOrEqual(100);
		}
	});

	it('is repeatable, so the handle is really being released each time', () => {
		// A leaked handle would eventually have WlanOpenHandle refuse; running the
		// cycle many times is the cheap way to notice.
		for (let i = 0; i < 20; i++) expect(readWindowsWifi()).toBeInstanceOf(Map);
	});
});
