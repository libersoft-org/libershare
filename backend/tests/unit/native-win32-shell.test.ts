import { expect, it } from 'bun:test';
import { checkShellExecuteResult } from '../../src/native/win32/shell.ts';

it('treats all ShellExecute error codes as failure and handles 64-bit success handles', () => {
	for (const code of [0, 2, 3, 5, 8, 26, 27, 28, 29, 30, 31, 32]) expect(() => checkShellExecuteResult(code)).toThrow('Windows could not open');
	expect(() => checkShellExecuteResult(33)).not.toThrow();
	expect(() => checkShellExecuteResult(0x100000000n)).not.toThrow();
});

async function openWith(initialized: number): Promise<{ calls: string[]; error: string | null }> {
	const script = `
		import { mock } from 'bun:test';
		const actual = await import('./src/native/library.ts');
		const calls = [];
		mock.module('./src/native/library.ts', () => ({ ...actual, loadSystemLibrary: name => ({ close() {}, symbols: name === 'ole32.dll'
			? { CoInitializeEx: (_reserved, mode) => { calls.push('CoInitializeEx:' + mode); return ${initialized}; }, CoUninitialize: () => { calls.push('CoUninitialize'); } }
			: { ShellExecuteW: () => { calls.push('ShellExecuteW'); return 42; } } }) }));
		const { openWindowsPath } = await import('./src/native/win32/shell.ts');
		let error = null;
		try { openWindowsPath((await import('node:path')).resolve('example.txt')); } catch (failure) { error = failure.message; }
		console.log(JSON.stringify({ calls, error }));
	`;
	const child = Bun.spawn([process.execPath, '--eval', script], { cwd: `${import.meta.dir}/../..`, stdout: 'pipe', stderr: 'pipe' });
	const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	if (code !== 0) throw new Error(err);
	return JSON.parse(out.trim());
}

it('joins a single-threaded COM apartment around ShellExecuteW and leaves it afterwards', async () => {
	expect(await openWith(0)).toEqual({ calls: ['CoInitializeEx:6', 'ShellExecuteW', 'CoUninitialize'], error: null });
	expect(await openWith(1)).toEqual({ calls: ['CoInitializeEx:6', 'ShellExecuteW', 'CoUninitialize'], error: null });
});

it('keeps an apartment the thread already has and refuses when COM cannot start', async () => {
	expect(await openWith(0x80010106 | 0)).toEqual({ calls: ['CoInitializeEx:6', 'ShellExecuteW'], error: null });
	const failed = await openWith(0x8007000e | 0);
	expect(failed.calls).toEqual(['CoInitializeEx:6']);
	expect(failed.error).toContain('CoInitializeEx');
});
