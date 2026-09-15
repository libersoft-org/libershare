import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

interface GuardResult {
	guard: number;
	apply: number;
	helper: number;
	scan: number;
	join: number;
	disconnect: number;
	code?: string;
	detail?: string;
}

function attempt(operation: 'apply' | 'scan' | 'join' | 'disconnect', busy: boolean, elevation = false): GuardResult {
	const script = `
		import { mock } from 'bun:test';
		import { promisify } from 'node:util';
		import { ipv4BaselineOf } from '@shared';
		const windows = await import('./src/system-network-windows.ts');
		const helper = await import('./src/network-helper-client.ts');
		const childProcess = await import('node:child_process');
		const calls = {guard:0,apply:0,helper:0,scan:0,join:0,disconnect:0};
		const iface = {id:'{11111111-2222-3333-4444-555555555555}',name:'Wi-Fi',medium:'wireless',link:'up',defaultRoute:true,mac:null,addresses:[{family:'ipv4',address:'192.0.2.10',prefixLength:24}],ipv4Mode:'static',ipv4Configurable:true,wifiConfigurable:true,gateway:'192.0.2.1',dns:[],wifi:{ssid:null,signal:null,radio:'on'}};
		const execFile = () => { throw new Error('Unexpected callback command'); };
		execFile[promisify.custom] = async (_file,args) => {
			if (args.at(-1) === windows.WINDOWS_STATE_COMMAND) return {stdout:'{}',stderr:''};
			calls.apply++; throw new Error('direct IPv4 write reached');
		};
		mock.module('node:child_process',()=>({...childProcess,execFile}));
		mock.module('./src/system-network-windows.ts',()=>({
			...windows,
			assertWindowsWifiMutationIdle:()=>{calls.guard++;if(${busy})throw new Error('Windows Wi-Fi outcome unknown; operation still finishing');},
			readWindowsWifi:()=>new Map(),
			parseWindowsNetworkState:()=>[iface],
			scanWindowsWifi:async()=>{calls.scan++;return [{ssid:'Example',ssidHex:'4578616D706C65',bssid:null,security:'WPA2',secured:true,supported:true,active:false,signal:80}];},
			connectWindowsWifi:async()=>{calls.join++;},
			disconnectWindowsWifi:async()=>{calls.disconnect++;},
		}));
		mock.module('./src/network-helper-client.ts',()=>({...helper,runElevatedNetworkHelper:async()=>{calls.helper++;throw new Error('elevated IPv4 write reached');}}));
		Object.defineProperty(process,'platform',{value:'win32'});
		const network=await import('./src/system-network.ts');
		await network.readCachedCapabilities(async()=>({ipv4:true,wifi:true,ipv4Elevation:${elevation},staticGatewayRequired:false}));
		let failure;
		try{
			if(${JSON.stringify(operation)}==='apply')await network.applyIPv4Unlocked(iface.id,{mode:'static',address:'192.0.2.20',prefixLength:24,gateway:'192.0.2.1'},'',true,ipv4BaselineOf(iface));
			if(${JSON.stringify(operation)}==='scan')await network.scanWifi(iface.id);
			if(${JSON.stringify(operation)}==='join')await network.connectWifiUnlocked(iface.id,'Example','example-password','',null,'WPA2','4578616D706C65');
			if(${JSON.stringify(operation)}==='disconnect')await network.disconnectWifiUnlocked(iface.id);
		}catch(error){failure={code:error.code,detail:error.detail};}
		console.log('RESULT:'+JSON.stringify({...calls,...failure}));
	`;
	const child = Bun.spawnSync([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../..'), timeout: 10_000 });
	if (child.exitCode !== 0) throw new Error(child.stderr.toString());
	expect(child.stderr.toString()).toBe('');
	const result = child.stdout.toString().split(/\r?\n/).find(line => line.startsWith('RESULT:'));
	expect(result).toBeDefined();
	return JSON.parse(result!.slice(7));
}

describe('Windows Wi-Fi quarantine in common network dispatch', () => {
	it.each(['scan', 'join', 'disconnect'] as const)('blocks %s before any platform operation', operation => {
		expect(attempt(operation, true)).toEqual({ guard: 1, apply: 0, helper: 0, scan: 0, join: 0, disconnect: 0, code: 'NETCONFIG_FAILED', detail: 'Windows Wi-Fi outcome unknown; operation still finishing' });
	});

	it.each([false, true])('blocks IPv4 before a write with elevation=%s', elevation => {
		expect(attempt('apply', true, elevation)).toEqual({ guard: 1, apply: 0, helper: 0, scan: 0, join: 0, disconnect: 0, code: 'NETCONFIG_FAILED', detail: 'Windows Wi-Fi outcome unknown; operation still finishing' });
	});

	it.each(['scan', 'join', 'disconnect'] as const)('permits %s when no operation remains pending', operation => {
		const result = attempt(operation, false);
		expect(result.guard).toBe(1);
		expect(result[operation]).toBe(1);
		expect(result.code).toBeUndefined();
	});

	it.each([false, true])('reaches the IPv4 mutation with elevation=%s after the guard clears', elevation => {
		const result = attempt('apply', false, elevation);
		expect(result.guard).toBe(1);
		expect(result.helper).toBe(elevation ? 1 : 0);
		expect(result.apply).toBe(elevation ? 0 : 1);
		expect(result.detail).toBe(elevation ? 'elevated IPv4 write reached' : 'direct IPv4 write reached');
	});
});
