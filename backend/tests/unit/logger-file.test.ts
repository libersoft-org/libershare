import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { LogObject } from 'consola';
import { createFileReporter } from '../../src/logger.ts';

/** The file reporter keeps its log open, but follows the path when the log is moved or deleted from outside. */
describe('createFileReporter', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'lish-log-'));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const line = (text: string): LogObject => ({ date: new Date(), level: 3, args: [text] }) as unknown as LogObject;

	it('writes to a new file at its path after the log was moved away', () => {
		const path = join(dir, 'app.log');
		const reporter = createFileReporter(path, 0);
		reporter.log(line('before'), {} as never);
		renameSync(path, join(dir, 'app.log.1'));
		reporter.log(line('after'), {} as never);
		expect(readFileSync(path, 'utf8')).toContain('after');
		expect(readFileSync(join(dir, 'app.log.1'), 'utf8')).not.toContain('after');
	});

	it('recreates the log after it was deleted', () => {
		const path = join(dir, 'app.log');
		const reporter = createFileReporter(path, 0);
		reporter.log(line('before'), {} as never);
		rmSync(path);
		reporter.log(line('after'), {} as never);
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, 'utf8')).toContain('after');
	});
});
