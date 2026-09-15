import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyTimesyncdDropIn, type CommandRunner, buildTimesyncdDropIn, parseTimesyncConfig, resolveSystemExecutable } from '../../src/system-time.ts';
import { parseUtcOffsetMinutes } from '../../src/system-time-common.ts';
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

	it('resolves date through the trusted system path', () => {
		expect(resolveSystemExecutable('linux', 'date')).toBe('/usr/bin/date');
	});
});

/**
 * The host's offset has to come from the HOST. `timedatectl show` carries the zone name and no
 * offset, so the shared status derived one from this runtime's timezone database - and where
 * the two disagree, which two tzdata versions on one machine are enough to produce, the screen
 * labelled a time the host does not have as the host's own. Editing the minutes from that
 * reading then moved the clock by the whole disagreement.
 */
/**
 * The read has to SAY that it found a daemon outside timedated's list, not just use the
 * finding for its own drop-in decision. That is the information the clock refusal needs.
 */
describe('an NTP daemon outside the managed list', () => {
	it('is reported by the status even while the host says NTP=no', async () => {
		const { status } = await readStatusScenario({ config: null, competing: true });
		expect(status.ntpEnabled).toBe(false);
		expect(status.clockHeldByUnmanagedDaemon).toBe(true);
		// The drop-in decision it was already used for is unchanged.
		expect(status.capabilities.setNtpServer).toBe(false);
	});

	it('is absent when nothing else is running', async () => {
		const { status } = await readStatusScenario({ config: '[Time]\nNTP=a.example.org\n' });
		expect(status.clockHeldByUnmanagedDaemon).toBeUndefined();
		expect(status.capabilities.setNtpServer).toBe(true);
	});

	/**
	 * `NTP=yes` is the ordinary case the existing refusal already covers, and the daemon
	 * running there is one timedated manages - so this flag would add nothing but a worse
	 * message.
	 */
	it('is not reported when the host already says synchronisation is on', async () => {
		const { status } = await readStatusScenario({ config: null, competing: true, enabled: true });
		expect(status.ntpEnabled).toBe(true);
		expect(status.clockHeldByUnmanagedDaemon).toBeUndefined();
	});

	/**
	 * The case that caught the first version of this fix, measured on Debian 12: installing
	 * chrony made `timedatectl show` answer `CanNTP=no` as well as `NTP=no`. The competing-unit
	 * read sat behind `canNtp`, so it was skipped entirely - nothing noticed chrony, and a
	 * hand-set clock went through while `chronyc tracking` showed the host synchronised to a
	 * stratum 3 peer. "Is another daemon running" is a question about the HOST, not about
	 * whether timedated can manage one.
	 */
	it('is reported even on a host whose timedated says it cannot do NTP at all', async () => {
		const { status, commands } = await readStatusScenario({ config: null, competing: true, canNtp: false });
		expect(status.clockHeldByUnmanagedDaemon).toBe(true);
		// Asked for, rather than inferred from a field that says nothing about it.
		expect(commands.some(entry => entry.command === 'systemctl' && entry.args.includes('ActiveState'))).toBe(true);
	});

	/**
	 * Projev A: timesyncd itself, running OUTSIDE timedated's ordered list.
	 *
	 * `competingNtpUnits` leaves timesyncd out on purpose - for the drop-in question, a daemon
	 * must not count as competing with itself. That answer was used for the CLOCK question too,
	 * so a timesyncd started outside the ordering was invisible: `timedatectl` says `NTP=no`
	 * because it is not a provider it manages, and the hand-set clock went through.
	 */
	it('includes timesyncd itself when the managed ordering does not account for it', async () => {
		const { status } = await readStatusScenario({ config: null, competing: 'timesyncd', ordered: ['chronyd.service'] });
		expect(status.ntpEnabled).toBe(false);
		expect(status.clockHeldByUnmanagedDaemon).toBe(true);
	});

	/**
	 * A daemon the fixed list knows only by an ALIAS. systemd answers for `chronyd.service`
	 * under the real unit's `Id` - `custom-clock.service` - and listed the alias only in
	 * `Names`. Keyed on `Id` alone, the activity read reported the daemon under a name the
	 * lookup never asked for, so a running daemon read as "nothing holds the clock" - and
	 * canonicalising through the load-state map could not help, because that map only knows
	 * the units of the ordering, never the fixed list. Both shapes the review reproduced:
	 * no managed provider at all, and timesyncd as the managed one.
	 */
	it.each([
		['no managed provider', []],
		['timesyncd managed', undefined],
	] as const)('sees a daemon that answers under another name (%s)', async (_label, ordered) => {
		const { status, commands } = await readStatusScenario({ config: null, alias: { name: 'chronyd.service', id: 'custom-clock.service' }, ...(ordered === undefined ? {} : { ordered: [...ordered] }) });
		expect(status.ntpEnabled).toBe(false);
		expect(status.clockHeldByUnmanagedDaemon).toBe(true);
		expect(status.capabilities.setNtpServer).toBe(false);
		// The names come with the states, so an alias is attributable without a second read.
		expect(commands.some(entry => entry.command === 'systemctl' && entry.args.includes('ActiveState') && entry.args.includes('Names'))).toBe(true);
	});

	/** Where the ordering DOES account for it, `NTP=yes`/`no` is timedated's own answer. */
	it('leaves timesyncd to timedated when it is a managed provider', async () => {
		const { status } = await readStatusScenario({ config: null, competing: 'timesyncd' });
		// Absent, not false: a definite "nothing unmanaged is steering this" is the default and
		// costs nothing to send, so only true and null are stated.
		expect(status.clockHeldByUnmanagedDaemon).toBeUndefined();
	});

	/**
	 * Projev B: the activity read failing is not "nothing is running".
	 *
	 * The condition was `competing !== null`, so a failed or timed-out read produced no flag at
	 * all - an unknown turned into permission to overwrite a clock somebody may own. Same
	 * mistake as reading an unreadable `NTP` field as off.
	 */
	it('reports unknown rather than safe when the activity read fails', async () => {
		const { status } = await readStatusScenario({ config: null, activityFails: true });
		expect(status.clockHeldByUnmanagedDaemon).toBeNull();
	});

	/** And an unreadable NTP field is not permission to ignore a daemon that IS running. */
	it('is reported when the host would not say whether synchronisation is on', async () => {
		const { status } = await readStatusScenario({ config: null, competing: true, ntpField: 'maybe' });
		expect(status.ntpEnabled).toBeNull();
		expect(status.clockHeldByUnmanagedDaemon).toBe(true);
	});
});

describe('the offset the linux status reports', () => {
	it('is the one the host answered', async () => {
		// `-0400`, which is Asunción's standard offset and the reading the measured
		// disagreement produced on one side.
		const { status } = await readStatusScenario({ config: '[Time]\nNTP=a.example.org\n', offset: '-0400' });
		expect(status.utcOffsetMinutes).toBe(-240);
	});

	it('asks the host for it rather than deriving it from the zone', async () => {
		const { commands } = await readStatusScenario({ config: null });
		expect(commands.some(entry => entry.command === 'date' && entry.args.join(' ') === '+%z')).toBe(true);
	});

	/**
	 * No answer means no claim. Leaving the field out puts the shared status back on its
	 * existing fallback, which is documented as a fallback - stating a made-up number as the
	 * host's is the failure being fixed here.
	 */
	it('states nothing when the host could not answer', async () => {
		for (const offset of [null, 'CEST']) {
			const { status } = await readStatusScenario({ config: null, offset });
			expect(status.utcOffsetMinutes).toBeUndefined();
		}
	});
});

describe('parseUtcOffsetMinutes', () => {
	it('reads the sign, the hours and the minutes', () => {
		expect(parseUtcOffsetMinutes('+0200')).toBe(120);
		expect(parseUtcOffsetMinutes('-0330')).toBe(-210);
		expect(parseUtcOffsetMinutes('+0000')).toBe(0);
		expect(parseUtcOffsetMinutes('-1200')).toBe(-720);
		expect(parseUtcOffsetMinutes('+0545')).toBe(345);
		// `date` ends its output with a newline, and `run` hands the text over as it came.
		expect(parseUtcOffsetMinutes('+0200\n')).toBe(120);
	});

	it('answers null for anything it was not given', () => {
		for (const value of [null, '', 'CEST', '+2:00', '0200', '+020', '+02000', 'x0200']) expect(parseUtcOffsetMinutes(value)).toBeNull();
	});
});

interface StatusScenario {
	config: string | null;
	runtime?: string | null;
	enabled?: boolean;
	owner?: 'ours' | 'foreign' | 'unknown' | 'masked';
	competing?: boolean | 'timesyncd';
	/** One asked unit is an alias: systemd answers under `id`, with `name` only in `Names`. */
	alias?: { name: string; id: string };
	activityFails?: boolean;
	ordered?: string[];
	canNtp?: boolean;
	ntpField?: string;
	offset?: string | null;
}
interface StatusResult {
	status: { ntpEnabled: boolean; ntpServer: string | null; utcOffsetMinutes?: number; clockHeldByUnmanagedDaemon?: boolean; capabilities: { setNtpServer: boolean } };
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
			if(command==='timedatectl'&&args[0]==='show')return 'Timezone=Europe/Prague\\nCanNTP='+(input.canNtp===false?'no':'yes')+'\\nNTP='+(input.ntpField??(input.enabled?'yes':'no'))+'\\nNTPSynchronized=no\\n';
			if(command==='timedatectl'&&args[0]==='show-timesync')return input.runtime??null;
			if(command==='systemctl'&&args[0]==='show-environment')return owner==='unknown'?null:'';
			if(command==='systemctl'&&args.includes('Environment'))return 'LoadState=loaded\\nEnvironment=SYSTEMD_TIMEDATED_NTP_SERVICES='+(input.ordered?input.ordered.join(':'):(owner==='foreign'?'chronyd.service:':'')+unit)+'\\n';
			if(command==='systemctl'&&args.includes('ActiveState')){
				if(input.activityFails)return null;
				// Real shape: an Id= / ActiveState= block per unit, blank line between them.
				// input.competing says which are running: true = the chrony-style ones,
				// 'timesyncd' = timesyncd itself is up outside the managed ordering.
				const asked=args.filter(a=>a.endsWith('.service'));
				const running=input.competing===true?asked.filter(u=>u!==unit):input.competing==='timesyncd'?[unit]:[];
				// input.alias: the asked name is an alias, and systemd answers for it under the
				// aliased unit's Id - with the alias listed only in Names, as measured on systemd 252.
				return asked.map(u=>{
					if(input.alias&&u===input.alias.name)return 'Id='+input.alias.id+'\\nNames='+input.alias.id+' '+u+'\\nActiveState=active';
					return 'Id='+u+'\\nNames='+u+'\\nActiveState='+(running.includes(u)?'active':'inactive');
				}).join('\\n\\n')+'\\n';
			}
			if(command==='systemctl'&&args.includes('Id'))return (owner==='foreign'?'Id=chronyd.service\\nNames=chronyd.service\\nLoadState=loaded\\n\\n':'')+'Id='+unit+'\\nNames='+unit+'\\nLoadState='+(owner==='masked'?'masked':'loaded')+'\\n';
			if(command==='date')return input.offset===undefined?'+0200':input.offset;
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
		// 0700 from `mkdtemp` is a directory the time service's own account could not enter, so
		// every positive case here would be refused for a reason unrelated to what it tests.
		if (process.platform !== 'win32') await chmod(dir, 0o755);
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
