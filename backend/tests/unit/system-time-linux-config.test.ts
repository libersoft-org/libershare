import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyTimesyncdDropIn, type CommandRunner, buildTimesyncdDropIn, parseTimesyncConfig, resolveSystemExecutable } from '../../src/system-time.ts';
import { verifyTimesyncdServer } from '../../src/system-time-linux.ts';
import { timesyncConfigOutput } from '../helpers/system-time-timesyncd.ts';

const OWN_CONFIG = '# /usr/lib/systemd/timesyncd.conf\n[Time]\nNTP=vendor.example.org\n# /etc/systemd/timesyncd.conf.d/90-libershare.conf\n' + buildTimesyncdDropIn('saved.example.org');
const OVERRIDDEN_CONFIG = OWN_CONFIG + '# /etc/systemd/timesyncd.conf.d/99-local.conf\n[Time]\nNTP=\nNTP=override.example.org\n';

describe('effective timesyncd configuration', () => {
	it('reads the saved server from the real drop-in format after the OS orders the files', () => {
		expect(parseTimesyncConfig(OWN_CONFIG)).toBe('saved.example.org');
	});

	it('uses a later administrator reset instead of assuming our 90 drop-in wins', () => {
		expect(parseTimesyncConfig(OVERRIDDEN_CONFIG)).toBe('override.example.org');
	});

	it('appends list assignments instead of replacing the first server without a reset', () => {
		expect(parseTimesyncConfig('[Time]\nNTP=first.example.org\nNTP=later.example.org\n')).toBe('first.example.org');
	});

	it('does not substitute fallback servers for an empty configured NTP list', () => {
		expect(parseTimesyncConfig('[Time]\nFallbackNTP=fallback.example.org\nNTP=first.example.org\n')).toBe('first.example.org');
		expect(parseTimesyncConfig('[Time]\nFallbackNTP=fallback.example.org\nNTP=first.example.org\nNTP=\n')).toBeNull();
		expect(parseTimesyncConfig('[Time]\nFallbackNTP=fallback.example.org\nFallbackNTP=\n')).toBeNull();
	});

	it('does not invent built-in fallback addresses or resurrect a masked file omitted by cat-config', () => {
		expect(parseTimesyncConfig('# /etc/systemd/timesyncd.conf\n[Time]\n# NTP=commented.example.org\n')).toBeNull();
		expect(parseTimesyncConfig('')).toBeNull();
	});

	it('ignores other sections and starts a new section context at every source file', () => {
		expect(parseTimesyncConfig('[Other]\nNTP=ignored.example.org\n[Time]\nNTP=correct.example.org\n')).toBe('correct.example.org');
		expect(parseTimesyncConfig('# /usr/lib/systemd/timesyncd.conf\n[Time]\n# /etc/systemd/timesyncd.conf.d/99-local.conf\nNTP=ignored.example.org\n')).toBeNull();
		expect(parseTimesyncConfig(OWN_CONFIG + '# /etc/systemd/timesyncd.conf.d/99-local.conf\nNTP=invalid-without-section.example.org\n')).toBeNull();
	});

	it('joins continuation lines across comment blocks using systemd whitespace rules', () => {
		expect(parseTimesyncConfig('[Time]\nNTP=\\\n # comment\n; another comment\n first.example.org second.example.org\n')).toBe('first.example.org');
		expect(parseTimesyncConfig('[Time]\nNTP=last.example.org\\')).toBe('last.example.org');
		expect(parseTimesyncConfig('[Time]\nNTP=broken.example.org\\  \nnext.example.org\n')).toBeNull();
	});

	it('accepts escaped hostname characters, CRLF and a file byte-order mark', () => {
		expect(parseTimesyncConfig('\uFEFF[Time]\r\nNTP=ntp\\.example\\.org\r\n')).toBe('ntp.example.org');
	});

	it.each(['"quoted.example.org"', "'quoted.example.org'", 'valid.example.org bad/host', '"unclosed.example.org', 'valid.example.org # inline comments are not supported'])('does not manufacture a server from invalid timesyncd syntax: %s', value => {
		expect(parseTimesyncConfig(`[Time]\nNTP=${value}\n`)).toBeNull();
	});

	it('rejects malformed section headers and embedded NULs', () => {
		expect(parseTimesyncConfig('[Time\nNTP=ntp.example.org\n')).toBeNull();
		expect(parseTimesyncConfig('[Time]\nNTP=ntp.example.org\0\n')).toBeNull();
	});

	it('resolves systemd-analyze through the trusted system path', () => {
		expect(resolveSystemExecutable('linux', 'systemd-analyze')).toBe('/usr/bin/systemd-analyze');
	});
});

interface StatusScenario {
	config: string | null;
	runtime?: string | null;
	enabled?: boolean;
	owner?: 'ours' | 'foreign' | 'unknown' | 'masked';
	competing?: boolean;
	canNtp?: boolean;
}
interface StatusResult {
	status: { ntpEnabled: boolean; ntpServer: string | null; capabilities: { setNtpServer: boolean } };
	commands: Array<{ command: string; args: string[] }>;
}

async function readStatusScenario(input: StatusScenario): Promise<StatusResult> {
	const script = `
		import {mock} from 'bun:test';
		const common = await import('./src/system-time-common.ts');
		const input=${JSON.stringify(input)};
		const commands=[];
		const unit='systemd-timesyncd.service';
		const owner=input.owner??'ours';
		async function read(command,args){
			commands.push({command,args});
			if(command==='timedatectl'&&args[0]==='show')return 'Timezone=Europe/Prague\\nCanNTP='+(input.canNtp===false?'no':'yes')+'\\nNTP='+(input.enabled?'yes':'no')+'\\nNTPSynchronized=no\\n';
			if(command==='timedatectl'&&args[0]==='show-timesync')return input.runtime??null;
			if(command==='systemctl'&&args[0]==='show-environment')return owner==='unknown'?null:'';
			if(command==='systemctl'&&args.includes('Environment'))return 'LoadState=loaded\\nEnvironment=SYSTEMD_TIMEDATED_NTP_SERVICES='+(owner==='foreign'?'chronyd.service:':'')+unit+'\\n';
			if(command==='systemctl'&&args.includes('Id'))return (owner==='foreign'?'Id=chronyd.service\\nNames=chronyd.service\\nLoadState=loaded\\n\\n':'')+'Id='+unit+'\\nNames='+unit+'\\nLoadState='+(owner==='masked'?'masked':'loaded')+'\\n';
			if(command==='systemctl'&&args.includes('ActiveState'))return input.competing?'active\\n':'inactive\\n';
			if(command==='systemd-analyze')return input.config;
			throw new Error('Unexpected command '+command+' '+args.join(' '));
		}
		mock.module('./src/system-time-common.ts',()=>({...common,tryRead:read,run:async(command,args)=>{const output=await read(command,args);return output===null?{kind:'failed',code:1,output:'read failed'}:{kind:'ok',output};}}));
		const {readLinuxStatus}=await import('./src/system-time-linux.ts');
		console.log(JSON.stringify({status:await readLinuxStatus(),commands}));
	`;
	const child = Bun.spawn([process.execPath, '--eval', script], { cwd: resolve(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' });
	const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
	try {
		const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		expect(code).toBe(0);
		expect(stderr).toBe('');
		const result: StatusResult = JSON.parse(stdout);
		for (const call of result.commands) expect(call.args.some(arg => ['restart', 'start', 'stop', 'set-ntp', 'set-time'].includes(arg))).toBe(false);
		return result;
	} finally {
		clearTimeout(deadline);
		if (child.exitCode === null) {
			child.kill('SIGKILL');
			await child.exited;
		}
	}
}

describe('Linux configured NTP server status', () => {
	it.each([
		[OWN_CONFIG, 'saved.example.org'],
		[OVERRIDDEN_CONFIG, 'override.example.org'],
	] as const)('reads the effective configured server without activating the daemon', async (config, server) => {
		const result = await readStatusScenario({ config });
		expect(result.status).toMatchObject({ ntpEnabled: false, ntpServer: server, capabilities: { setNtpServer: true } });
		expect(result.commands.filter(call => call.command === 'systemd-analyze')).toEqual([{ command: 'systemd-analyze', args: ['--no-pager', 'cat-config', 'systemd/timesyncd.conf'] }]);
	});

	it('reports configured A instead of active or DHCP peer B while synchronization is enabled', async () => {
		const result = await readStatusScenario({ config: OWN_CONFIG, enabled: true, runtime: 'ServerName=active.example.org\nSystemNTPServers=loaded-before-save.example.org\nLinkNTPServers=dhcp.example.org\n' });
		expect(result.status).toMatchObject({ ntpEnabled: true, ntpServer: 'saved.example.org' });
		expect(result.commands.some(call => call.command === 'systemd-analyze')).toBe(true);
		expect(result.commands.some(call => call.args.includes('show-timesync'))).toBe(false);
	});

	it('does not report an active peer change as a configured server change', async () => {
		const before = await readStatusScenario({ config: OWN_CONFIG, enabled: true, runtime: 'ServerName=peer-one.example.org\n' });
		const after = await readStatusScenario({ config: OWN_CONFIG, enabled: true, runtime: 'ServerName=peer-two.example.org\n' });
		expect(before.status.ntpServer).toBe('saved.example.org');
		expect(after.status).toEqual(before.status);
	});

	it.each([null, '[Time]\nNTP=\nFallbackNTP=fallback.example.org\n'])('does not fill an unknown or empty saved server from runtime or fallback data', async config => {
		const result = await readStatusScenario({ config, enabled: true, runtime: 'ServerName=active.example.org\nLinkNTPServers=dhcp.example.org\nFallbackNTPServers=builtin.example.org\n' });
		expect(result.status.ntpServer).toBeNull();
	});

	it.each(['foreign', 'unknown', 'masked'] as const)('does not trust a timesyncd drop-in when ownership is %s', async owner => {
		const result = await readStatusScenario({ config: OWN_CONFIG, owner });
		expect(result.status.ntpServer).toBeNull();
		expect(result.commands.some(call => call.command === 'systemd-analyze')).toBe(false);
	});

	it.each([{ competing: true }, { canNtp: false }])('does not read a server for a host timesyncd cannot safely manage: %j', async options => {
		const result = await readStatusScenario({ config: OWN_CONFIG, ...options });
		expect(result.status.ntpServer).toBeNull();
		expect(result.commands.some(call => call.command === 'systemd-analyze')).toBe(false);
	});

	it.each([null, '[Time]\nNTP="invalid.example.org"\n'])('returns unknown when effective configuration cannot be read or parsed', async config => {
		const result = await readStatusScenario({ config });
		expect(result.status.ntpServer).toBeNull();
	});
});

describe('verification of a published timesyncd drop-in', () => {
	let dir = '';
	let file = '';
	const original = '[Time]\nNTP=original.example.org\n';
	const requested = 'requested.example.org';
	const laterReset = '# /etc/systemd/timesyncd.conf.d/99-local.conf\n[Time]\nNTP=\nNTP=override.example.org\n';
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'lish-timesync-verify-'));
		file = join(dir, '90-libershare.conf');
		await writeFile(file, original);
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it.each([false, true])('checks the published file before success with synchronization running=%s', async running => {
		const calls: string[] = [];
		const exec: CommandRunner = async (command, args) => {
			calls.push(command);
			if (command === 'systemd-analyze') {
				expect(await readFile(file, 'utf8')).toBe(buildTimesyncdDropIn(requested));
				return { kind: 'ok', output: await timesyncConfigOutput(file) };
			}
			expect([command, ...args]).toEqual(['systemctl', 'restart', 'systemd-timesyncd']);
			return { kind: 'ok', output: '' };
		};
		expect((await applyTimesyncdDropIn(requested, running, file, exec)).success).toBe(true);
		expect(calls).toEqual(running ? ['systemd-analyze', 'systemctl'] : ['systemd-analyze']);
	});

	it.each([false, true])('does not activate or accept a server overridden by a later file with synchronization running=%s', async running => {
		const calls: string[] = [];
		const higherFile = join(dir, '99-local.conf');
		await writeFile(higherFile, laterReset);
		const exec: CommandRunner = async command => {
			calls.push(command);
			return { kind: 'ok', output: await timesyncConfigOutput(file, await readFile(higherFile, 'utf8')) };
		};
		const result = await applyTimesyncdDropIn(requested, running, file, exec);
		expect(result.success).toBe(false);
		expect(result.message).toContain('effective');
		expect(await readFile(file, 'utf8')).toBe(original);
		expect(await readFile(higherFile, 'utf8')).toBe(laterReset);
		expect(calls).toEqual(['systemd-analyze']);
	});

	it.each([false, true].flatMap(running => (['missing', 'read-error', 'timeout', 'invalid', 'throw'] as const).map(failure => ({ running, failure }))))('rolls back without restarting when verification fails: %j', async ({ running, failure }) => {
		const calls: string[] = [];
		const exec: CommandRunner = async command => {
			calls.push(command);
			if (failure === 'throw') throw new Error('read failed');
			if (failure === 'missing') return { kind: 'missing' };
			if (failure === 'timeout') return { kind: 'timeout' };
			if (failure === 'read-error') return { kind: 'failed', code: 1, output: 'read denied' };
			return { kind: 'ok', output: '[Time]\nNTP="invalid.example.org"\n' };
		};
		const result = await applyTimesyncdDropIn(requested, running, file, exec);
		expect(result.success).toBe(false);
		expect(await readFile(file, 'utf8')).toBe(original);
		expect(calls).toEqual(['systemd-analyze']);
	});

	it.each([false, true])('preserves a concurrent edit while undoing verification failure (file existed=%s)', async existed => {
		if (!existed) await rm(file);
		const external = '[Time]\nNTP=external.example.org\n';
		const calls: string[] = [];
		const exec: CommandRunner = async command => {
			calls.push(command);
			await writeFile(file, external);
			return { kind: 'ok', output: await timesyncConfigOutput(file) };
		};
		const result = await applyTimesyncdDropIn(requested, true, file, exec);
		expect(result.success).toBe(false);
		expect(result.changed).toBe(true);
		expect(result.message).toContain('could not be restored');
		expect(await readFile(file, 'utf8')).toBe(external);
		expect(calls).toEqual(['systemd-analyze']);
	});

	it('removes only its newly created file when a later override prevents verification', async () => {
		await rm(file);
		const higherFile = join(dir, '99-local.conf');
		await writeFile(higherFile, laterReset);
		const calls: string[] = [];
		const exec: CommandRunner = async command => {
			calls.push(command);
			return { kind: 'ok', output: await timesyncConfigOutput(file, await readFile(higherFile, 'utf8')) };
		};
		expect((await applyTimesyncdDropIn(requested, false, file, exec)).success).toBe(false);
		await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
		expect(await readFile(higherFile, 'utf8')).toBe(laterReset);
		expect(calls).toEqual(['systemd-analyze']);
	});

	it.each(['[Time]\nNTP=requested.example.org other.example.org\n', '[Time]\nNTP=\nFallbackNTP=requested.example.org\n'])('does not verify a single-server pin from only the first or fallback entry', async configuration => {
		const failure = await verifyTimesyncdServer(requested, async () => ({ kind: 'ok', output: configuration }));
		expect(failure).toContain('differs');
	});
});
