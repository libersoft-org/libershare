import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

function scenario(input: { state?: 'ours' | 'idle' | 'foreign' | 'unknown' | 'same-ssid-other-profile'; cancelFails?: boolean; cancelStuck?: boolean; recover?: boolean; recoverOwn?: boolean; recoverForeign?: boolean; foreignProfileEdit?: boolean; probeConflicts?: boolean; rollbackFails?: boolean; synchronousFailure?: boolean }): any {
	const script = `
		import { mock } from 'bun:test';
		import { ptr, toArrayBuffer } from 'bun:ffi';
		import { buildList } from './tests/helpers/windows-wifi.ts';
		const input = ${JSON.stringify(input)};
		const native = await import('./src/system-network-windows-wlan.ts');
		const profile = await import('./src/system-network-windows-profiles.ts');
		const guid = '{11111111-2222-3333-4444-555555555555}';
		const hex = Buffer.from('Example').toString('hex').toUpperCase();
		const original = profile.windowsWifiProfileXml('Saved connection',new TextEncoder().encode('Example'),'previous-password');
		let xml = original, queued = false, cancelled = false, recovery = false;
		let calls = 0, cancels = 0;
		const events = [], retained = [];
		const list = buildList([{ssid:'Example',profileName:'Saved connection',auth:7,cipher:4,signal:70}]);
		const api = {
			WlanScan:()=>{events.push('scan');return 0;},
			WlanGetAvailableNetworkList: (_h,_g,_f,_r,out) => {new BigUint64Array(toArrayBuffer(out,0,8))[0]=BigInt(list);return 0;},
			WlanGetProfile: (_h,_g,_n,_r,out,flags) => {const buffer=native.utf16z(xml);retained.push(buffer);new BigUint64Array(toArrayBuffer(out,0,8))[0]=BigInt(ptr(buffer));new Uint32Array(toArrayBuffer(flags,0,4))[0]=2;return 0;},
			WlanGetProfileCustomUserData:()=>2,
			WlanSetProfile:(_h,_g,_f,buffer)=>{const next=native.readUtf16z(buffer);events.push(next===original?'rollback':'write');if(input.rollbackFails&&next===original)return 5;xml=next;return 0;},
			WlanConnect:()=>{events.push('connect');calls++; if(input.synchronousFailure)return 5; queued=true;return 0;},
			WlanDisconnect:()=>{events.push('cancel');cancels++;if(input.cancelFails&&!recovery)return 5;cancelled=true;if(!input.cancelStuck||recovery)queued=false;return 0;},
			WlanFreeMemory:()=>{},
		};
		mock.module('./src/system-network-windows-wlan.ts',()=>({...native,
			withWlanHandle:action=>action(api,1n),
			readAssociation:()=>null,
			isWindowsWifiDisconnected:()=>!queued,
			readWindowsWifiOperationState:()=>{
				if(recovery && input.recoverForeign)return {state:1,profileName:'Other connection',ssidHex:'4F74686572'};
				if(recovery && input.recoverOwn && queued)return {state:1,profileName:'Saved connection',ssidHex:hex};
				if(recovery || (cancelled&&!queued) || input.state==='idle') return {state:4,profileName:null,ssidHex:null};
				if(input.state==='unknown')throw new Error('native state unavailable');
				if(input.state==='same-ssid-other-profile')return {state:1,profileName:'Other connection',ssidHex:hex};
				if(input.state==='foreign')return {state:1,profileName:'Other connection',ssidHex:'4F74686572'};
				return {state:5,profileName:'Saved connection',ssidHex:hex};
			},
		}));
		let ticks=0;Date.now=()=>++ticks*10001;
		const timer=setTimeout;globalThis.setTimeout=(fn,delay,...args)=>timer(fn,delay===500?0:delay,...args);
		const wifi=await import('./src/system-network-windows-wifi.ts');
		let failure=null;
		try{await wifi.connectWindowsWifi(guid,'Example','new-password','WPA2',hex);}catch(error){failure=error.message;}
		const beforeRecovery={queued,cancels,restored:xml===original,events:[...events]};
		const conflictErrors=[];
		if(input.probeConflicts){
			for(const action of [()=>wifi.scanWindowsWifi(guid),()=>wifi.connectWindowsWifi(guid,'Example','new-password','WPA2',hex),()=>wifi.disconnectWindowsWifi(guid)]){
				try{await action();conflictErrors.push(null);}catch(error){conflictErrors.push(error.message);}
			}
		}
		let blocked=false;try{wifi.assertWindowsWifiMutationIdle?.();}catch{blocked=true;}
		if(input.foreignProfileEdit)xml=original.replace('previous-password','external-password');
		const cancelsBeforeRecovery=cancels;
		if(input.recover){recovery=true;queued=!!input.recoverOwn||!!input.recoverForeign;}
		let recoveryBlocked=false,recoveryError=null;try{wifi.assertWindowsWifiMutationIdle?.();}catch(error){recoveryBlocked=true;recoveryError=error.message;}
		let nextBlocked=false;try{wifi.assertWindowsWifiMutationIdle?.();}catch{nextBlocked=true;}
		console.log('RESULT:'+JSON.stringify({failure,beforeRecovery,blocked,recoveryBlocked,recoveryError,nextBlocked,cancels,cancelsBeforeRecovery,restored:xml===original,conflictErrors,foreignProfileRetained:xml.includes('external-password'),events,calls}));
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

describe('Windows join cancellation before profile rollback', () => {
	it('cancels the accepted operation before restoring its profile', () => {
		const result = scenario({ state: 'ours' });
		expect(result.beforeRecovery).toMatchObject({ queued: false, cancels: 1, restored: true });
		expect(result.events).toEqual(['write', 'connect', 'cancel', 'rollback']);
		expect(result.blocked).toBe(false);
	});
	it('still submits cancellation when the adapter appears disconnected with a queued join', () => {
		const result = scenario({ state: 'idle' });
		expect(result.beforeRecovery).toMatchObject({ queued: false, cancels: 1, restored: true });
	});
	it.each([{ state: 'foreign' as const }, { state: 'unknown' as const }, { state: 'same-ssid-other-profile' as const }])('does not disconnect a foreign or unreadable association: %j', input => {
		const result = scenario(input);
		expect(result.beforeRecovery).toMatchObject({ cancels: 0, restored: false });
		expect(result.blocked).toBe(true);
		expect(result.failure).toContain('unknown');
	});
	it.each([{ cancelFails: true }, { cancelStuck: true }])('keeps profiles and the mutation barrier until cancellation is confirmed: %j', input => {
		const result = scenario(input);
		expect(result.beforeRecovery).toMatchObject({ restored: false });
		expect(result.blocked).toBe(true);
	});
	it('blocks every conflicting platform operation while another connection makes cancellation unsafe', () => {
		const result = scenario({ state: 'foreign', probeConflicts: true });
		expect(result.conflictErrors).toHaveLength(3);
		expect(result.conflictErrors.every((message: string) => message.includes('unknown result'))).toBe(true);
		expect(result.events).toEqual(['write', 'connect']);
	});
	it('finishes deferred profile cleanup before allowing the next mutation', () => {
		const result = scenario({ cancelStuck: true, recover: true });
		expect(result.beforeRecovery.restored).toBe(false);
		expect(result.blocked).toBe(true);
		expect(result.recoveryBlocked).toBe(false);
		expect(result.restored).toBe(true);
	});
	it('cancels a late own association whose identity was initially unavailable', () => {
		const result = scenario({ state: 'unknown', recover: true, recoverOwn: true });
		expect(result.beforeRecovery).toMatchObject({ cancels: 0, restored: false });
		expect(result.blocked).toBe(true);
		expect(result.recoveryBlocked).toBe(false);
		expect(result.cancels).toBe(1);
		expect(result.restored).toBe(true);
	});
	it('reissues cancellation for a late own association after an earlier cancellation was accepted', () => {
		const result = scenario({ cancelStuck: true, recover: true, recoverOwn: true });
		expect(result.beforeRecovery).toMatchObject({ cancels: 1, restored: false });
		expect(result.recoveryBlocked).toBe(false);
		expect(result.cancels).toBe(result.cancelsBeforeRecovery + 1);
		expect(result.restored).toBe(true);
		expect(result.nextBlocked).toBe(false);
	});
	it('does not reissue cancellation after the unfinished attempt is replaced by a foreign connection', () => {
		const result = scenario({ cancelStuck: true, recover: true, recoverForeign: true });
		expect(result.beforeRecovery.cancels).toBe(1);
		expect(result.recoveryBlocked).toBe(true);
		expect(result.cancels).toBe(result.cancelsBeforeRecovery);
		expect(result.restored).toBe(false);
	});
	it('never overwrites a profile edited while the failed operation is quarantined', () => {
		const result = scenario({ cancelStuck: true, recover: true, foreignProfileEdit: true });
		expect(result.foreignProfileRetained).toBe(true);
		expect(result.recoveryError).toContain('profile recovery failed');
		expect(result.nextBlocked).toBe(false);
	});
	it('reports deferred rollback failure once without claiming the native operation is still pending', () => {
		const result = scenario({ cancelStuck: true, recover: true, rollbackFails: true });
		expect(result.restored).toBe(false);
		expect(result.recoveryError).toContain('profile recovery failed');
		expect(result.recoveryError).not.toContain('unknown result');
		expect(result.nextBlocked).toBe(false);
	});
	it('restores a synchronous refusal without disconnecting the current network', () => {
		const result = scenario({ synchronousFailure: true });
		expect(result.beforeRecovery).toMatchObject({ cancels: 0, restored: true });
		expect(result.blocked).toBe(false);
	});
});
