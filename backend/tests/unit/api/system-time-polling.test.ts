import { expect, it } from 'bun:test';
import { resolve } from 'node:path';

it('refreshes external time changes without overlapping writes or publishing after stop', async () => {
	const script = `
		import { mock } from 'bun:test';
		const time = await import('./src/system-time.ts');
		const volume = await import('./src/system-volume.ts');
		let tick, intervals = 0, clears = 0, now = 0, wanted = false, reads = 0, releaseRead;
		let holdRead = false;
		const events = [], order = [];
		let state = {supported:true,nowMs:1000000,timezone:'UTC',utcOffsetMinutes:0,timezoneSource:'intl',ntpEnabled:true,ntpSynchronized:false,ntpServer:'ntp.example.org',capabilities:{setClock:true,setTimezone:true,setNtpServer:true,setNtpEnabled:true}};
		mock.module('./src/system-time.ts',()=>({...time,getSystemTimeStatus:async()=>{
			reads++;order.push('read');
			if(holdRead)await new Promise(resolve=>releaseRead=resolve);
			return structuredClone(state);
		}}));
		mock.module('./src/system-volume.ts',()=>({...volume,getSystemVolumeStatus:async()=>null}));
		globalThis.setInterval=(callback,period)=>{if(period!==5000)throw new Error('Unexpected interval');tick=callback;intervals++;return 1;};
		globalThis.clearInterval=()=>{clears++;};
		Object.defineProperty(performance,'now',{value:()=>now,configurable:true});
		const {initSystemHandlers}=await import('./src/api/system.ts');
		const handlers=initSystemHandlers({get:()=>'',set:async()=>{}},(event,status)=>{events.push({event,status});order.push('published');},event=>wanted&&event==='system:timeChanged',true);
		const settle=async()=>{await new Promise(setImmediate);await new Promise(setImmediate);};
		handlers.startPolling();handlers.startPolling();
		await tick();await settle();const withoutSubscribers=reads;
		wanted=true;await tick();await settle();const initialReads=reads;
		state={...state,nowMs:1315000,ntpSynchronized:true};
		now=5000;await tick();now=10000;await tick();await settle();const beforeDeadline=reads;
		now=15000;await tick();await settle();const externalEvent=events.at(-1);
		holdRead=true;now=30000;await tick();await settle();
		const pendingReads=reads;
		now=45000;await tick();await settle();const overlappingReads=reads;
		let wrote=false;
		const writer=time.withSystemTimeLock(async()=>{wrote=true;order.push('write');});
		await settle();const writeWhileReading=wrote;
		releaseRead();holdRead=false;await writer;await settle();const writeOrder=order.slice(-3);
		holdRead=true;now=60000;await tick();await settle();
		const eventsBeforeStop=events.length;
		handlers.stopPolling();releaseRead();holdRead=false;await settle();
		const eventsAfterStop=events.length;
		now=75000;await tick();await settle();const stoppedReads=reads;
		handlers.startPolling();await tick();await settle();const restartedReads=reads;
		holdRead=true;now=90000;await tick();await settle();
		const eventsBeforeUnsubscribe=events.length;
		wanted=false;releaseRead();holdRead=false;await settle();
		const eventsAfterUnsubscribe=events.length;
		handlers.stopPolling();
		console.log(JSON.stringify({withoutSubscribers,initialReads,beforeDeadline,externalEvent,pendingReads,overlappingReads,writeWhileReading,writeOrder,eventsBeforeStop,eventsAfterStop,stoppedReads,restartedReads,eventsBeforeUnsubscribe,eventsAfterUnsubscribe,intervals,clears}));
	`;
	const child = Bun.spawn([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../../..'), stdout: 'pipe', stderr: 'pipe' });
	const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		if (exitCode !== 0) throw new Error(`Polling fixture exited ${exitCode}: ${stderr}`);
		expect(stderr).toBe('');
		const result = JSON.parse(stdout);
		expect(result.withoutSubscribers).toBe(0);
		expect(result.initialReads).toBe(1);
		expect(result.beforeDeadline).toBe(1);
		expect(result.externalEvent).toMatchObject({ event: 'system:timeChanged', status: { nowMs: 1315000, ntpSynchronized: true } });
		expect(result.pendingReads).toBe(3);
		expect(result.overlappingReads).toBe(3);
		expect(result.writeWhileReading).toBe(false);
		expect(result.writeOrder).toEqual(['read', 'published', 'write']);
		expect(result.eventsAfterStop).toBe(result.eventsBeforeStop);
		expect(result.stoppedReads).toBe(4);
		expect(result.restartedReads).toBe(5);
		expect(result.eventsAfterUnsubscribe).toBe(result.eventsBeforeUnsubscribe);
		expect(result.intervals).toBe(2);
		expect(result.clears).toBe(2);
	} finally {
		clearTimeout(deadline);
		if (child.exitCode === null) {
			child.kill('SIGKILL');
			await child.exited;
		}
	}
});
