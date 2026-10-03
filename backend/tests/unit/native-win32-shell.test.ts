import { expect, it } from 'bun:test';
import { checkShellExecuteResult } from '../../src/native/win32/shell.ts';

it('treats all ShellExecute error codes as failure and handles 64-bit success handles', () => {
	for (const code of [0, 2, 3, 5, 8, 26, 27, 28, 29, 30, 31, 32]) expect(() => checkShellExecuteResult(code)).toThrow('Windows could not open');
	expect(() => checkShellExecuteResult(33)).not.toThrow();
	expect(() => checkShellExecuteResult(0x100000000n)).not.toThrow();
});
