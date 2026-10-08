import { expect, test } from 'bun:test';
import { windowsTimeWriteFailure } from '../../src/native/win32/time-worker.ts';
import { WindowsTimeNativeError } from '../../src/native/win32/time-native.ts';
import { resolve } from 'node:path';

test('native Windows time errors preserve denial, refusal and unknown execution', () => {
	for (const code of [5, 1300, 1314]) expect(windowsTimeWriteFailure(new WindowsTimeNativeError('write', code), true)).toMatchObject({ kind: 'denied', stateMayHaveChanged: false });
	expect(windowsTimeWriteFailure(new WindowsTimeNativeError('write', 87), true)).toMatchObject({ kind: 'failed', code: 87, stateMayHaveChanged: false });
	for (const code of [5, 1460, 1722]) expect(windowsTimeWriteFailure(new WindowsTimeNativeError('RPC', code, true), true)).toMatchObject({ kind: 'unknown', endRule: { kind: 'boot' } });
});

for (const scenario of ['start', 'stop', 'already-running', 'already-stopped', 'denied', 'rpc-failure', 'query-failure', 'pending']) {
	test(`native W32Time control observes completion: ${scenario}`, async () => {
		const script = `
		import {mock} from 'bun:test';
		import {ptr,toArrayBuffer} from 'bun:ffi';
		const scenario=${JSON.stringify(scenario)};
		let queries=0,closed=0,controls=0;
		const error=scenario==='denied'||scenario==='query-failure'?5:scenario==='rpc-failure'?1722:scenario==='already-running'?1056:scenario==='already-stopped'?1062:0;
		mock.module('./src/native/library.ts',()=>({loadSystemLibrary:()=>({close:()=>{},symbols:{
		 OpenSCManagerW:()=>1n,OpenServiceW:()=>2n,CloseServiceHandle:()=>{closed++;return 1},GetLastError:()=>error,
		 StartServiceW:()=>{controls++;return scenario==='query-failure'?1:error?0:1},ControlService:()=>{controls++;return scenario==='query-failure'?1:error?0:1},
		 QueryServiceStatusEx:(_handle,_level,data)=>{queries++;if(scenario==='query-failure')return 0;new DataView(toArrayBuffer(data,0,36)).setUint32(4,scenario==='pending'?2:scenario.includes('stop')?1:4,true);return 1},
		}})}));
		const {writeWindowsTimeService}=await import('./src/native/win32/time-native.ts');
		let failure=null;
		try{writeWindowsTimeService({kind:scenario.includes('stop')?'stop':'start',timeoutMs:1})}catch(error){failure={code:error.code,mayHaveRun:error.mayHaveRun}}
		console.log(JSON.stringify({failure,queries,closed,controls}));
		`;
		const child = Bun.spawn([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' });
		const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		if (code !== 0) throw new Error(error);
		const result = JSON.parse(output);
		expect(result.closed).toBe(2);
		expect(result.controls).toBe(1);
		if (['start', 'stop', 'already-running', 'already-stopped'].includes(scenario)) {
			expect(result.failure).toBeNull();
			expect(result.queries).toBeGreaterThan(0);
		} else expect(result.failure).toMatchObject({ mayHaveRun: scenario !== 'denied' });
	});
}
