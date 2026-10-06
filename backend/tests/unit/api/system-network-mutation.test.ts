import { describe, expect, it } from 'bun:test';
import { restrictNetworkCapabilities, runAndPublishNetworkMutation } from '../../../src/api/system.ts';
import { runNetworkMutation } from '../../../src/system-network.ts';
import type { NetworkStateInfo } from '@shared';
import { resolve } from 'node:path';

it('keeps OS state readable and refuses changes when the native journal cannot be read', async () => {
	const script = `
		import { mock } from 'bun:test';
		const time=await import('./src/system-time.ts'), volume=await import('./src/system-volume.ts'), network=await import('./src/system-network.ts'), helper=await import('./src/network-helper-client.ts');
		let writes=0, broken=true;
		const status={supported:true,nowMs:123,timezone:'UTC',stale:false,capabilities:{setClock:true,setTimezone:true,setNtpServer:true,setNtpEnabled:true}};
		const state={known:true,detail:'full',stale:false,interfaces:[],capabilities:{ipv4:true,wifi:true,ipv4Elevation:true}};
		mock.module('./src/system-time.ts',()=>({...time,getSystemTimeStatus:async()=>status}));
		mock.module('./src/system-volume.ts',()=>({...volume,getSystemVolumeStatus:async()=>null}));
		mock.module('./src/system-network.ts',()=>({...network,readNetworkState:async()=>state,applyIPv4Unlocked:async()=>{writes++;return state;}}));
		mock.module('./src/network-helper-client.ts',()=>({...helper,warmElevationTrust:()=>{}}));
		const {NativeMutationHost}=await import('./src/native/mutation-host.ts');
		NativeMutationHost.prototype.state=async()=>{if(broken)throw Error('Invalid native mutation journal');};
		NativeMutationHost.prototype.recover=async()=>{};
		const {initSystemHandlers}=await import('./src/api/system.ts');
		const handlers=initSystemHandlers({get:()=>'',set:async()=>{}},()=>{},()=>false,true,process.cwd());
		try {
			const time=await handlers.getTime(), network=await handlers.network();
			const results=await Promise.allSettled([handlers.setNtpEnabled({enabled:false}),handlers.networkApply({interfaceID:'test0',config:{mode:'dhcp'},expected:{}})]);
			broken=false;
			console.log(JSON.stringify({time,network,rejected:results.map(item=>item.status),writes,recovered:await handlers.getTime()}));
		} finally {await handlers.close();}
	`;
	const child = Bun.spawn([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe' });
	const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	if (code) throw new Error(error);
	const result = JSON.parse(out);
	expect(result.time).toMatchObject({ supported: true, nowMs: 123, stale: true, capabilities: { setClock: false, setTimezone: false, setNtpServer: false, setNtpEnabled: false } });
	expect(result.network).toMatchObject({ known: true, stale: true, capabilities: { ipv4: false, wifi: false, ipv4Elevation: false } });
	expect(result.rejected).toEqual(['rejected', 'rejected']);
	expect(result.writes).toBe(0);
	expect(result.recovered.stale).toBe(false);
});

it('publishes the interrupted operation after a failed Wi-Fi change', async () => {
	const script = `
		import { mock } from 'bun:test';
		const volume=await import('./src/system-volume.ts'), network=await import('./src/system-network.ts'), helper=await import('./src/network-helper-client.ts');
		let failed=false;
		const state={known:true,detail:'full',stale:false,interfaces:[],capabilities:{ipv4:true,wifi:true,ipv4Elevation:true}};
		const fail=async()=>{failed=true;throw Error('association failed');};
		mock.module('./src/system-volume.ts',()=>({...volume,getSystemVolumeStatus:async()=>null}));
		mock.module('./src/system-network.ts',()=>({...network,readNetworkState:async()=>state,readNetworkStateUnlocked:async()=>state,connectWifiUnlocked:fail,disconnectWifiUnlocked:fail}));
		mock.module('./src/network-helper-client.ts',()=>({...helper,warmElevationTrust:()=>{}}));
		const {NativeMutationHost}=await import('./src/native/mutation-host.ts');
		const {NativeNetworkChanges}=await import('./src/native/network-changes.ts');
		NativeMutationHost.prototype.state=async()=>failed?{state:'interrupted',since:1,operation:'connectWifi'}:undefined;
		NativeMutationHost.prototype.recover=async()=>{};
		NativeNetworkChanges.prototype.wifi=async(_request,action)=>action();
		const {initSystemHandlers}=await import('./src/api/system.ts');
		const published=[];
		const handlers=initSystemHandlers({get:()=>'',set:async()=>{}},(_event,value)=>published.push(value),()=>false,true,process.cwd());
		try {
			for (const run of [()=>handlers.wifiConnect({interfaceID:'wlan0',ssid:'Demo',password:'demo-password'}),()=>handlers.wifiDisconnect({interfaceID:'wlan0'})]) {
				failed=false;
				await run().catch(()=>{});
			}
			console.log(JSON.stringify(published.map(value=>value.mutation?.state ?? null)));
		} finally {await handlers.close();}
	`;
	const child = Bun.spawn([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe' });
	const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	if (code) throw new Error(error);
	expect(JSON.parse(out)).toEqual(['interrupted', 'interrupted']);
});

it('an acknowledgement still reading back holds off a new change and answers with the full state', async () => {
	const script = `
		import { mock } from 'bun:test';
		const volume=await import('./src/system-volume.ts'), network=await import('./src/system-network.ts'), helper=await import('./src/network-helper-client.ts');
		const state={known:true,detail:'full',stale:false,interfaces:[],capabilities:{ipv4:true,wifi:true,ipv4Elevation:true}};
		let hostState={state:'interrupted',since:1,operation:'applyIPv4'}, release, gated=false, finish;
		// The first read after the record is cleared waits, the window another client can use.
		const read=async()=>{if(!gated&&hostState===undefined){gated=true;await new Promise(resolve=>(release=resolve));}return state;};
		mock.module('./src/system-volume.ts',()=>({...volume,getSystemVolumeStatus:async()=>null}));
		mock.module('./src/system-network.ts',()=>({...network,readNetworkState:read,readNetworkStateUnlocked:read}));
		mock.module('./src/network-helper-client.ts',()=>({...helper,warmElevationTrust:()=>{}}));
		const {NativeMutationHost}=await import('./src/native/mutation-host.ts');
		const {NativeNetworkChanges}=await import('./src/native/network-changes.ts');
		NativeMutationHost.prototype.state=async()=>hostState;
		NativeMutationHost.prototype.acknowledge=async()=>{hostState=undefined;};
		NativeMutationHost.prototype.recover=async()=>{};
		NativeNetworkChanges.prototype.applyIPv4=async()=>{hostState={state:'running',since:2,operation:'applyIPv4'};await new Promise(resolve=>(finish=resolve));hostState=undefined;return state;};
		const {initSystemHandlers}=await import('./src/api/system.ts');
		const published=[];
		const handlers=initSystemHandlers({get:()=>'',set:async()=>{}},(_event,value)=>published.push(value),()=>false,true,process.cwd());
		try {
			const ack=handlers.acknowledgeNetwork({operationId:'6f1c2d3e-4a5b-4c6d-8e7f-a0b1c2d3e4f5'});
			while(!release) await Bun.sleep(1);
			const apply=handlers.networkApply({interfaceID:'test0',config:{mode:'dhcp'},expected:{}}).then(()=>'applied',error=>error.code??error.message);
			await Bun.sleep(20);
			const runningDuringAck=hostState?.state??null;
			release();
			const answer=await ack;
			finish?.();
			console.log(JSON.stringify({apply:await apply,runningDuringAck,answered:answer.mutation?.state??null,published:published.map(value=>value.mutation?.state??null)}));
		} finally {await handlers.close();}
	`;
	const child = Bun.spawn([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe' });
	const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	if (code) throw new Error(error);
	const result = JSON.parse(out.trim().split('\n').pop()!);
	expect(result).toEqual({ apply: 'NETCONFIG_BUSY', runningDuringAck: null, answered: null, published: [null] });
});

function state(): NetworkStateInfo {
	return {
		known: true,
		ipv4ProfilesUnavailable: false,
		detail: 'full',
		primaryID: null,
		capabilities: { ipv4: true, wifi: true, staticGatewayRequired: false },
		interfaces: [],
	};
}

describe('network mutation publishing', () => {
	it('publishes the fresh state before rethrowing the original mutation error', async () => {
		const original = new Error('join failed');
		const published: NetworkStateInfo[] = [];
		const fresh = state();

		await expect(
			runAndPublishNetworkMutation(
				async () => Promise.reject(original),
				async () => fresh,
				value => published.push(value)
			)
		).rejects.toBe(original);
		expect(published).toEqual([fresh]);
	});

	it('rejects another change while the failed mutation is still reading back', async () => {
		const order: string[] = [];
		let releaseRead: () => void = () => {};
		const readBlocked = new Promise<void>(resolve => (releaseRead = resolve));
		const failing = runAndPublishNetworkMutation(
			async () => {
				order.push('mutation');
				throw new Error('apply failed');
			},
			async () => {
				order.push('read-back:start');
				await readBlocked;
				order.push('read-back:end');
				return state();
			},
			() => order.push('publish')
		).catch(() => {});
		const refused = await runNetworkMutation(async () => {
			order.push('unexpected-write');
		}).catch(error => error);
		expect(refused.code).toBe('NETCONFIG_BUSY');
		await Promise.resolve();
		releaseRead();
		await failing;
		expect(order).toEqual(['mutation', 'read-back:start', 'read-back:end', 'publish']);
		await runNetworkMutation(async () => {
			order.push('new-write');
		});
		expect(order[order.length - 1]).toBe('new-write');
	});

	it('hides write capabilities when the API has no authentication token', () => {
		const current = state();
		expect(restrictNetworkCapabilities(current, false).capabilities).toEqual({ ipv4: false, ipv4Elevation: false, wifi: false, staticGatewayRequired: false });
		expect(restrictNetworkCapabilities(current, true)).toBe(current);
	});
});
