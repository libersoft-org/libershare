import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

async function runFixture(script: string): Promise<Record<string, unknown>> {
	const child = Bun.spawn([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' });
	const [code, text, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	if (code !== 0) throw new Error(error);
	return JSON.parse(text.trim());
}

test.skipIf(process.platform !== 'win32')('Windows launcher waits past an old timeout without terminating the helper', async () => {
	const result = await runFixture(`
		import {mock} from 'bun:test';import {toArrayBuffer} from 'bun:ffi';
		const actual=await import('./src/native/library.ts');let polls=0,kills=0,closed=0,terminationDeclared=false;
		mock.module('./src/native/library.ts',()=>({...actual,loadSystemLibrary:(_name,declarations)=>{
			terminationDeclared=terminationDeclared||('TerminateProcess' in declarations);
			return {symbols:{ShellExecuteExW:p=>{new DataView(toArrayBuffer(p,0,112)).setBigUint64(104,256n,true);return 1;},WaitForSingleObject:()=>++polls<4?258:0,GetExitCodeProcess:(_h,p)=>{new DataView(toArrayBuffer(p,0,4)).setUint32(0,0,true);return 1;},TerminateProcess:()=>{kills++;return 1;},CloseHandle:()=>{closed++;return 1;},GetLastError:()=>0},close:()=>{}};
		}}));
		const {runElevatedWindowsProcess}=await import('./src/network-helper-windows.ts');
		const started=performance.now();const outcome=await runElevatedWindowsProcess('C:\\\\Program Files\\\\Example\\\\helper.exe','--request-file example',1);
		console.log(JSON.stringify({outcome,kills,closed,polls,terminationDeclared,elapsed:performance.now()-started}));
	`);
	expect(result['outcome']).toEqual({ kind: 'exited', code: 0 });
	expect(result['kills']).toBe(0);
	expect(result['terminationDeclared']).toBe(false);
	expect(result['closed']).toBe(1);
	expect(Number(result['elapsed'])).toBeGreaterThanOrEqual(100);
});

test('an elapsed caller wait leaves the launcher alive and accepts only its durable result', async () => {
	const result = await runFixture(`
		import {mock} from 'bun:test';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
		const cp=await import('node:child_process'),store=await import('./src/native/helper-results-store.ts'),ownership=await import('./src/native/mutation-context.ts'),identity=await import('./src/native/process-identity.ts');
		let request=null,kills=0,persisted=false,deliveredAfterPersist=false,cancelled=false,completed=false,optionsHaveTimeout=false,recovered=null;
		const context={operationId:'00000000-0000-4000-8000-000000000001',dataDirectory:process.cwd(),remainingMs:()=>10,recordExecution:async(_rule,data)=>{persisted=true;if(data)recovered=data;},call:async(_rule,invoke)=>{const result=await invoke();if(!result.known)throw new Error('unknown');return result.value;}};
		mock.module('./src/native/mutation-context.ts',()=>({...ownership,requireNativeMutationContext:()=>context}));
		mock.module('./src/native/process-identity.ts',()=>({...identity,nativeProcessIdentity:pid=>({pid,started:'test-start'}),getNativeBootId:()=> 'test-boot'}));
		mock.module('./src/native/helper-results-store.ts',()=>({...store,createHelperCancellation:async()=>{cancelled=true;},HelperResultStore:class{async read(){return {operationId:request.operationId,requestHash:store.helperRequestHash(request),bootId:'test-boot',phase:'finished',recoveryData:{time:{clock:{targetUtcMs:123}}},result:{outcome:'known',response:{ok:true,time:{success:true,outcome:'ok',message:null}}}};}}}));
		mock.module('node:child_process',()=>({...cp,spawn:(_file,_args,options)=>{
			optionsHaveTimeout='timeout' in options;const child=new EventEmitter();child.pid=123;child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{kills++;};
			child.stdin.on('data',chunk=>{request=JSON.parse(chunk.toString());deliveredAfterPersist=persisted;});
			setTimeout(()=>{completed=true;child.stdout.end('invalid stdout is not authoritative');child.stderr.end();child.emit('close',0);},80);return child;
		}}));
		const {runElevatedSystemTime}=await import('./src/network-helper-client.ts');
		const work=runElevatedSystemTime({ntpEnabled:false},'linux',()=>1000,async()=>true);
		const early=await Promise.race([work.then(()=>false),Bun.sleep(15).then(()=>true)]);const aliveAtDeadline=!completed;
		const result=await work;console.log(JSON.stringify({early,aliveAtDeadline,kills,optionsHaveTimeout,deliveredAfterPersist,cancelled,version:request.version,deadline:request.deadlineUptime,result,recovered}));
	`);
	expect(result['early']).toBe(true);
	expect(result['aliveAtDeadline']).toBe(true);
	expect(result['kills']).toBe(0);
	expect(result['optionsHaveTimeout']).toBe(false);
	expect(result['deliveredAfterPersist']).toBe(true);
	expect(result['cancelled']).toBe(true);
	expect(result['version']).toBe(2);
	expect(result['deadline']).toBe(1000.01);
	expect(result['result']).toEqual({ success: true, outcome: 'ok', message: null });
	expect(result['recovered']).toEqual({ time: { clock: { targetUtcMs: 123 } } });
});
