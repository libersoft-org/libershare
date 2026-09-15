import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

interface EnvironmentResult {
	outcome: string;
	child: { hasTZ: boolean; timezone: string | null; locale: string; marker: string };
	parentTZ: string | null;
	inheritedTimezone: string | null;
	parentLocale: string;
	intlUnchanged: boolean;
	cloned: boolean;
	command: string | null;
	args: string[] | null;
}

async function inspectEnvironment(platform: 'darwin' | 'linux' | 'native', withTZ: boolean): Promise<EnvironmentResult> {
	const script = `
		import { mock } from 'bun:test';
		import { promisify } from 'node:util';
		const nativeChildProcess = await import('node:child_process');
		const beforeIntl = Intl.DateTimeFormat().resolvedOptions().timeZone;
		let captured;
		if (${JSON.stringify(platform)} !== 'native') {
			const execFile = () => { throw new Error('Unexpected callback execution'); };
			execFile[promisify.custom] = async (command, args, options) => {
				captured = { command, args, cloned: options.env !== process.env,
					child: {hasTZ:Object.hasOwn(options.env,'TZ'),timezone:options.env.TZ??null,locale:options.env.LC_ALL,marker:options.env.LISH_TIME_ENV_MARKER} };
				return {stdout:'fixture output',stderr:''};
			};
			mock.module('node:child_process',()=>({...nativeChildProcess,execFile}));
			Object.defineProperty(process,'platform',{value:${JSON.stringify(platform)}});
		}
		const { run } = await import('./src/system-time-common.ts');
		const realScript = "console.log(JSON.stringify({hasTZ:typeof process.env.TZ!=='undefined',timezone:process.env.TZ??null,locale:process.env.LC_ALL,marker:process.env.LISH_TIME_ENV_MARKER}))";
		const command = ${JSON.stringify(platform)} === 'native' ? process.execPath : ${JSON.stringify(platform)} === 'darwin' ? '/usr/sbin/systemsetup' : 'timedatectl';
		const args = ${JSON.stringify(platform)} === 'native' ? ['--eval',realScript] : ${JSON.stringify(platform)} === 'darwin' ? ['-gettimezone'] : ['set-time','2026-08-14 23:46:28'];
		let inheritedTimezone = null;
		if (${JSON.stringify(platform)} === 'native') {
			const inherited = await promisify(nativeChildProcess.execFile)(process.execPath, ['--eval',realScript], {env:{...process.env,LC_ALL:'C'}});
			inheritedTimezone = JSON.parse(inherited.stdout).timezone;
		}
		const result = await run(command,args);
		if (result.kind !== 'ok') throw new Error('System-time runner failed: '+JSON.stringify(result));
		console.log(JSON.stringify({outcome:result.kind,child:captured?.child??JSON.parse(result.output),cloned:captured?.cloned??true,
			inheritedTimezone,command:captured?.command??null,args:captured?.args??null,parentTZ:process.env.TZ??null,parentLocale:process.env.LC_ALL,
			intlUnchanged:beforeIntl===Intl.DateTimeFormat().resolvedOptions().timeZone}));
	`;
	// Inherit TZ at process startup; late setters are not always enumerable in Bun.
	const env: Record<string, string | undefined> = { ...process.env, LC_ALL: 'fixture-locale', LISH_TIME_ENV_MARKER: 'preserved' };
	if (withTZ) env['TZ'] = 'UTC';
	else delete env['TZ'];
	const child = Bun.spawn([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../..'), env, stdout: 'pipe', stderr: 'pipe' });
	const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
	try {
		const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		expect(code).toBe(0);
		expect(stderr).toBe('');
		return JSON.parse(stdout);
	} finally {
		clearTimeout(deadline);
		if (child.exitCode === null) {
			child.kill('SIGKILL');
			await child.exited;
		}
	}
}

describe('system-time command environment', () => {
	it.each(['darwin', 'linux'] as const)('does not pass application TZ to %s system commands', async platform => {
		const result = await inspectEnvironment(platform, true);
		expect(result).toMatchObject({ outcome: 'ok', child: { hasTZ: false, timezone: null, locale: 'C', marker: 'preserved' }, parentTZ: 'UTC', parentLocale: 'fixture-locale', intlUnchanged: true, cloned: true });
		expect(result.command).toBe(platform === 'darwin' ? '/usr/sbin/systemsetup' : '/usr/bin/timedatectl');
		expect(result.args).toEqual(platform === 'darwin' ? ['-gettimezone'] : ['set-time', '2026-08-14 23:46:28']);
	});

	it('keeps an originally absent TZ absent without changing the parent environment', async () => {
		expect(await inspectEnvironment('darwin', false)).toMatchObject({ child: { hasTZ: false, timezone: null, locale: 'C', marker: 'preserved' }, parentTZ: null, parentLocale: 'fixture-locale', intlUnchanged: true, cloned: true });
	});

	it('passes the sanitized environment through a real child process', async () => {
		expect(await inspectEnvironment('native', true)).toMatchObject({ outcome: 'ok', inheritedTimezone: 'UTC', child: { hasTZ: false, timezone: null, locale: 'C', marker: 'preserved' }, parentTZ: 'UTC', parentLocale: 'fixture-locale', intlUnchanged: true });
	});
});
