import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { hostNetworkAdminHandler } from '../../src/api/api.ts';

function subprocess(script: string): any {
	const result = Bun.spawnSync([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../..'), timeout: 15000 });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	const line = result.stdout.toString().split(/\r?\n/).find(line => line.startsWith('RESULT:'));
	expect(line).toBeDefined();
	return JSON.parse(line!.slice(7));
}

function windowsDisconnect(states: Array<boolean | string>, error = 0): any {
	return subprocess(`
		import { mock } from 'bun:test';
		const native = await import('./src/system-network-windows-wlan.ts');
		const states = ${JSON.stringify(states)};
		let reads = 0, disconnects = 0;
		mock.module('./src/system-network-windows-wlan.ts', () => ({ ...native,
			isWindowsWifiDisconnected: () => { const state = states[Math.min(reads++, states.length - 1)]; if (typeof state === 'string') throw new Error(state); return state; },
			withWlanHandle: action => action({ WlanDisconnect: () => { disconnects++; return ${error}; } }, 1n),
		}));
		const now = Date.now; let ticks = 0;
		Date.now = () => now() + ticks++ * 10001;
		const timer = setTimeout;
		globalThis.setTimeout = (callback, delay, ...args) => timer(callback, delay === 500 ? 0 : delay, ...args);
		const { disconnectWindowsWifi } = await import('./src/system-network-windows-wifi.ts');
		let failure = null;
		try { await disconnectWindowsWifi('{11111111-2222-3333-4444-555555555555}'); } catch (error) { failure = error.message; }
		console.log('RESULT:' + JSON.stringify({ reads, disconnects, failure }));
	`);
}

describe('Wi-Fi disconnect authorization', () => {
	it.each([{ token: false, local: true }, { token: true, local: false }])('refuses unauthorized requests before any action: %j', ({ token, local }) => {
		let mutations = 0;
		const guarded = hostNetworkAdminHandler(token, () => mutations++);
		expect(() => guarded({}, { data: { isLocalClient: local, subscribedEvents: new Set() } })).toThrow('authenticated client on this machine');
		expect(mutations).toBe(0);
	});

	it('runs an authenticated local request', () => {
		let mutations = 0;
		hostNetworkAdminHandler(true, () => mutations++)({}, { data: { isLocalClient: true, subscribedEvents: new Set() } });
		expect(mutations).toBe(1);
	});
});

describe('Windows native disconnect', () => {
	it('waits for a confirmed disconnected state after the request is accepted', () => {
		expect(windowsDisconnect([false, false, true])).toEqual({ reads: 3, disconnects: 1, failure: null });
	});

	it('is idempotent when the interface is already disconnected', () => {
		expect(windowsDisconnect([true])).toEqual({ reads: 1, disconnects: 0, failure: null });
	});

	it('does not turn a failed state query into successful disconnection', () => {
		const result = windowsDisconnect([false, 'query failed']);
		expect(result.disconnects).toBe(1);
		expect(result.failure).toContain('query failed');
		expect(result.failure).toContain('unknown result');
	});

	it('reports an interface which remains connected', () => {
		expect(windowsDisconnect([false]).failure).toContain('did not disconnect');
	});

	it('reports a native refusal without treating the queued request as successful', () => {
		expect(windowsDisconnect([false], 5)).toMatchObject({ reads: 1, disconnects: 1, failure: expect.any(String) });
	});
});

describe('Linux native disconnect', () => {
	it.each(['30 (disconnected)', '100 (connected)', ''])('verifies the resulting NetworkManager state: %s', state => {
		const result = subprocess(`
			import { mock } from 'bun:test';
			import { promisify } from 'node:util';
			const child = await import('node:child_process');
			const commands = [];
			const execFile = () => {};
			execFile[promisify.custom] = async (bin, args, options) => { commands.push(args); if(options.env.LC_ALL !== 'C') throw new Error('Wrong locale'); return { stdout: args.includes('GENERAL.STATE') ? ${JSON.stringify(state)} : '' }; };
			mock.module('node:child_process', () => ({ ...child, execFile }));
			const { disconnectLinuxWifi } = await import('./src/system-network-linux.ts');
			let failure = null;
			try { await disconnectLinuxWifi('wlan0'); } catch(error) { failure = error.message; }
			console.log('RESULT:' + JSON.stringify({ commands, failure }));
		`);
		expect(result.commands).toHaveLength(2);
		expect(result.commands[0].slice(-3)).toEqual(['device', 'disconnect', 'wlan0']);
		expect(result.commands[1]).toEqual(['-g', 'GENERAL.STATE', 'device', 'show', 'wlan0']);
		if (state.startsWith('30')) expect(result.failure).toBeNull();
		else expect(result.failure).toContain('did not disconnect');
	});
});

it('serializes the RPC disconnect through its readback and publishes the resulting state', () => {
	const result = subprocess(`
		import { mock } from 'bun:test';
		const platform = await import('./src/system-network-linux.ts');
		const volume = await import('./src/system-volume.ts');
		const iface = { id:'wlan0', name:'Wi-Fi', medium:'wireless', link:'up', defaultRoute:false, mac:null, addresses:[], ipv4Mode:'dhcp', ipv4Configurable:true, wifiConfigurable:true, gateway:null, dns:[], wifi:{ssid:'Example',radio:'on',signal:80} };
		let active = true; const order = [];
		mock.module('./src/system-network-linux.ts', () => ({ ...platform,
			readLinuxCapabilities: async () => ({ipv4:true,wifi:true,staticGatewayRequired:false}),
			readLinuxNetworkState: async () => { order.push(active ? 'read-before' : 'read-after'); return [{...iface,link:active?'up':'down',wifi:{...iface.wifi,ssid:active?'Example':null}}]; },
			disconnectLinuxWifi: async () => { order.push('disconnect'); active = false; },
		}));
		mock.module('./src/system-volume.ts', () => ({...volume,getSystemVolumeStatus:async()=>null}));
		Object.defineProperty(process,'platform',{value:'linux'});
		const { initSystemHandlers } = await import('./src/api/system.ts');
		const { runNetworkMutation } = await import('./src/system-network.ts');
		const handlers = initSystemHandlers({get:()=>''}, (_event,state)=>order.push('published:' + state.interfaces[0].link), ()=>false, true);
		const pending = handlers.wifiDisconnect({interfaceID:'wlan0'});
		const queued = runNetworkMutation(async()=>order.push('next-mutation'));
		const state = await pending; await queued;
		console.log('RESULT:' + JSON.stringify({ order, link:state.interfaces[0].link,ssid:state.interfaces[0].wifi.ssid }));
	`);
	expect(result).toEqual({ order: ['read-before', 'disconnect', 'read-after', 'published:down', 'next-mutation'], link: 'down', ssid: null });
});

 it.each([1, 4, 5, 7])('reads native interface state %i without treating transitional states as disconnected', state => {
	const result = subprocess(`
		import { mock } from 'bun:test';
		const ffi = await import('bun:ffi');
		const memory = new Uint8Array(540); const view = new DataView(memory.buffer);
		view.setUint32(0,1,true); memory.set([0x11,0x11,0x11,0x11,0x22,0x22,0x33,0x33,0x44,0x44,0x55,0x55,0x55,0x55,0x55,0x55],8); view.setUint32(536,${state},true);
		let freed=0;
		mock.module('bun:ffi',()=>({...ffi,dlopen:()=>({symbols:{
			WlanOpenHandle:(_v,_r,_n,handle)=>{new BigUint64Array(ffi.toArrayBuffer(handle,0,8))[0]=1n;return 0;},
			WlanCloseHandle:()=>0,
			WlanEnumInterfaces:(_h,_r,out)=>{new BigUint64Array(ffi.toArrayBuffer(out,0,8))[0]=BigInt(ffi.ptr(memory));return 0;},
			WlanFreeMemory:()=>{freed++;},
		}})}));
		const {isWindowsWifiDisconnected}=await import('./src/system-network-windows-wlan.ts');
		console.log('RESULT:'+JSON.stringify({disconnected:isWindowsWifiDisconnected('{11111111-2222-3333-4444-555555555555}'),freed}));
	`);
	expect(result).toEqual({disconnected:state===4,freed:1});
});
