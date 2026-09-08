import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

function readSnapshot(options: { state?: number; rc?: number; size?: number; profile?: string; enumState?: number }): any {
	const script = `
		import {mock} from 'bun:test';
		const ffi=await import('bun:ffi');
		const input=${JSON.stringify(options)};
		const connection=new Uint8Array(604);const attributes=new DataView(connection.buffer);
		attributes.setUint32(0,input.state??5,true);
		const profile=Buffer.from((input.profile??'Saved connection')+'\\0','utf16le');connection.set(profile.subarray(0,512),8);
		attributes.setUint32(520,2,true);connection.set([0xff,0xfe],524);attributes.setUint32(576,80,true);
		const interfaces=new Uint8Array(540);const view=new DataView(interfaces.buffer);view.setUint32(0,1,true);
		interfaces.set([0x11,0x11,0x11,0x11,0x22,0x22,0x33,0x33,0x44,0x44,0x55,0x55,0x55,0x55,0x55,0x55],8);view.setUint32(536,input.enumState??4,true);
		let freed=0,enumReads=0;
		mock.module('bun:ffi',()=>({...ffi,dlopen:()=>({symbols:{
			WlanOpenHandle:(_v,_r,_n,out)=>{new BigUint64Array(ffi.toArrayBuffer(out,0,8))[0]=1n;return 0;},WlanCloseHandle:()=>0,
			WlanQueryInterface:(_h,_g,_o,_r,size,out)=>{if(input.rc)return input.rc;new Uint32Array(ffi.toArrayBuffer(size,0,4))[0]=input.size??604;new BigUint64Array(ffi.toArrayBuffer(out,0,8))[0]=BigInt(ffi.ptr(connection));return 0;},
			WlanEnumInterfaces:(_h,_r,out)=>{enumReads++;new BigUint64Array(ffi.toArrayBuffer(out,0,8))[0]=BigInt(ffi.ptr(interfaces));return 0;},
			WlanFreeMemory:()=>{freed++;},
		}})}));
		const {readWindowsWifiOperationState}=await import('./src/system-network-windows-wlan.ts');
		let state=null,error=null;try{state=readWindowsWifiOperationState('{11111111-2222-3333-4444-555555555555}');}catch(failure){error=failure.message;}
		console.log('RESULT:'+JSON.stringify({state,error,freed,enumReads}));
	`;
	const result = Bun.spawnSync([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../..'), timeout: 10000 });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	const line = result.stdout
		.toString()
		.split(/\r?\n/)
		.find(line => line.startsWith('RESULT:'));
	expect(line).toBeDefined();
	return JSON.parse(line!.slice(7));
}

describe('Windows active operation identity', () => {
	it('reads the native profile name separately from the raw SSID while associating', () => {
		expect(readSnapshot({})).toEqual({ state: { state: 5, profileName: 'Saved connection', ssidHex: 'FFFE' }, error: null, freed: 1, enumReads: 0 });
	});
	it.each([1, 7])('retains the native profile identity in state %i', state => {
		expect(readSnapshot({ state }).state).toEqual({ state, profileName: 'Saved connection', ssidHex: 'FFFE' });
	});
	it.each([4, 1])('uses strict interface state %i after ERROR_INVALID_STATE', enumState => {
		expect(readSnapshot({ rc: 5023, enumState })).toEqual({ state: { state: enumState, profileName: null, ssidHex: null }, error: null, freed: 1, enumReads: 1 });
	});
	it.each([4, 1])('retains only independently verified state %i when connection identity is denied', enumState => {
		expect(readSnapshot({ rc: 5, enumState })).toEqual({ state: { state: enumState, profileName: null, ssidHex: null }, error: null, freed: 1, enumReads: 1 });
	});
	it.each([{ size: 603 }, { state: 8 }])('rejects incomplete or invalid native data: %j', options => {
		expect(readSnapshot(options)).toMatchObject({ state: null, error: expect.any(String), freed: 1 });
	});
});
