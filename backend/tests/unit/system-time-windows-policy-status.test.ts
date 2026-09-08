import { expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import type { SystemTimeStatus } from '@shared';

it('reports only confirmed Windows settings while preserving policy write protection', async () => {
	const cases = [
		{ name: 'policy replaces local NoSync', type: 'NoSync', policy: 'present', start: 'automatic', enabled: null, server: null, writable: false },
		{ name: 'policy replaces local NTP peers', type: 'NTP', policy: 'present', start: 'on-demand', enabled: null, server: null, writable: false },
		{ name: 'policy and type are unreadable', type: null, policy: 'unknown', start: 'automatic', enabled: null, server: null, writable: false },
		{ name: 'policy cannot be read despite a local peer list', type: 'NTP', policy: 'unknown', start: 'automatic', enabled: null, server: null, writable: false },
		{ name: 'local mode is unreadable', type: null, policy: 'absent', start: 'automatic', enabled: null, server: null, writable: false },
		{ name: 'unmanaged NoSync preserves its saved peer', type: 'NoSync', policy: 'absent', start: 'on-demand', enabled: false, server: 'local.example.org', writable: true },
		{ name: 'unmanaged NTP exposes its configured peer', type: 'NTP', policy: 'absent', start: 'automatic', enabled: true, server: 'local.example.org', writable: true },
		{ name: 'domain membership restricts writes without hiding known manual settings', type: 'NTP', policy: 'absent', start: 'automatic', membership: 'domain', enabled: true, server: 'local.example.org', writable: false },
		{ name: 'domain hierarchy is not represented by a leftover manual peer', type: 'NT5DS', policy: 'absent', start: 'automatic', membership: 'domain', enabled: true, server: null, writable: false },
	];
	const script = `
		import {mock} from 'bun:test';
		const common=await import('./src/system-time-common.ts');
		mock.module('./src/system-time-common.ts',()=>({...common,tryRead:async(cmd,args)=>{
			if(cmd==='reg'&&args.at(-1)==='NtpServer')return 'NtpServer    REG_SZ    local.example.org,0x8';
			if(cmd==='w32tm')return 'Leap Indicator: 0(no warning)\\nLast Successful Sync Time: 2026-09-08 12:00:00';
			throw new Error('Unexpected read');
		}}));
		Object.defineProperty(process,'platform',{value:'win32',configurable:true});
		const windows=await import('./src/system-time-windows.ts');
		const time=await import('./src/system-time.ts');
		const results=[];
		for(const input of ${JSON.stringify(cases)}){
			const readMode=async()=>({mode:windows.parseWindowsSyncMode(input.type,windows.readWindowsPolicyManaged(()=>input.policy)),start:input.start,membership:input.membership??'standalone',running:false});
			const platform=await windows.readWindowsStatus(()=>({windowsId:'UTC',utcOffsetMinutes:0,daylightDisabled:false}),readMode);
			const status=await time.getSystemTimeStatus(async()=>platform);
			let writes=0;
			const exec=async()=>{writes++;return {kind:'ok',output:''};};
			let refused=[];
			if(!input.writable){
				refused.push((await time.setSystemNtpEnabled(true,async()=>status,exec,readMode)).success);
				refused.push((await time.setSystemNtpServer('new.example.org',async()=>status,readMode,exec)).success);
				if(input.enabled===null)refused.push((await time.setSystemClock(12,0,0,async()=>status,exec)).success);
			}
			results.push({status,writes,refused});
		}
		console.log(JSON.stringify(results));
	`;
	const child = Bun.spawn([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' });
	const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
	try {
		const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		if (code !== 0) throw new Error(`Windows policy fixture exited ${code}: ${stderr}`);
		const results: Array<{ status: SystemTimeStatus; writes: number; refused: boolean[] }> = JSON.parse(stdout);
		expect(results).toHaveLength(cases.length);
		for (const [index, input] of cases.entries()) {
			const observed = results[index]!;
			expect({ name: input.name, enabled: observed.status.ntpEnabled, server: observed.status.ntpServer }).toEqual({ name: input.name, enabled: input.enabled, server: input.server });
			expect(observed.status.capabilities.setNtpEnabled).toBe(input.writable);
			expect(observed.status.capabilities.setNtpServer).toBe(input.writable);
			expect(observed.writes).toBe(0);
			expect(observed.refused.every(success => !success)).toBe(true);
		}
	} finally {
		clearTimeout(deadline);
		if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
	}
}, 15000);
