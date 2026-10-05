import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

async function declined(platform: 'linux' | 'win32', exitCode: string, stderr: string): Promise<Record<string, unknown>> {
	const script = `
		import {mock} from 'bun:test';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
		const cp=await import('node:child_process'),store=await import('./src/native/helper-results-store.ts'),ownership=await import('./src/native/mutation-context.ts'),identity=await import('./src/native/process-identity.ts');
		const {WINDOWS_LAUNCHER_EXIT}=await import('./src/network-helper-windows.ts');
		const context={operationId:'00000000-0000-4000-8000-000000000001',dataDirectory:process.cwd(),remainingMs:()=>10000,recordExecution:async()=>{},call:async(_rule,invoke)=>{const result=await invoke();if(!result.known)throw new Error('unknown');return result.value;}};
		mock.module('./src/native/mutation-context.ts',()=>({...ownership,requireNativeMutationContext:()=>context}));
		mock.module('./src/native/process-identity.ts',()=>({...identity,nativeProcessIdentity:pid=>({pid,started:'test-start'}),getNativeBootId:()=>'test-boot'}));
		mock.module('./src/native/helper-results-store.ts',()=>({...store,createHelperCancellation:async()=>{},HelperResultStore:class{async read(){return null;}}}));
		mock.module('node:child_process',()=>({...cp,spawn:()=>{
			const child=new EventEmitter();child.pid=123;child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
			setTimeout(()=>{child.stdout.end();child.stderr.end(${JSON.stringify(stderr)});child.emit('close',${exitCode});},10);return child;
		}}));
		const {runElevatedSystemTime}=await import('./src/network-helper-client.ts');
		console.log(JSON.stringify(await runElevatedSystemTime({ntpEnabled:false},${JSON.stringify(platform)},()=>1000,async()=>true)));
	`;
	const child = Bun.spawn([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' });
	const [code, text, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	if (code !== 0) throw new Error(error);
	return JSON.parse(text.trim());
}

test('a dismissed pkexec prompt reaches the time screen as declined through the tracked launch', async () => {
	const result = await declined('linux', '126', 'Error executing command as another user: Request dismissed');
	expect(result['outcome']).toBe('elevation-declined');
	expect(result['stateMayHaveChanged']).toBeUndefined();
});

test('a cancelled Windows prompt reaches the time screen as declined through the tracked launch', async () => {
	const result = await declined('win32', 'WINDOWS_LAUNCHER_EXIT.cancelled', '');
	expect(result['outcome']).toBe('elevation-declined');
});

test('a launcher that fails for another reason stays a plain error', async () => {
	const result = await declined('linux', '1', 'pkexec: helper crashed');
	expect(result['outcome']).toBe('error');
});
