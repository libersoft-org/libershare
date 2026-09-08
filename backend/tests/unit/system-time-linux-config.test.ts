import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { buildTimesyncdDropIn, parseTimesyncConfig, resolveSystemExecutable } from '../../src/system-time.ts';

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

	it('uses explicit fallback servers only when the effective NTP list is empty', () => {
		expect(parseTimesyncConfig('[Time]\nFallbackNTP=fallback.example.org\nNTP=first.example.org\n')).toBe('first.example.org');
		expect(parseTimesyncConfig('[Time]\nFallbackNTP=fallback.example.org\nNTP=first.example.org\nNTP=\n')).toBe('fallback.example.org');
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
	owner?: 'ours' | 'foreign' | 'unknown' | 'masked';
	competing?: boolean;
	canNtp?: boolean;
}
interface StatusResult {
	status: { ntpEnabled: boolean; ntpServer: string | null; capabilities: { setNtpServer: boolean } };
	commands: Array<{ command: string; args: string[] }>;
}

async function offlineStatus(input: StatusScenario): Promise<StatusResult> {
	const script = `
		import {mock} from 'bun:test';
		const common = await import('./src/system-time-common.ts');
		const input=${JSON.stringify(input)};
		const commands=[];
		const unit='systemd-timesyncd.service';
		const owner=input.owner??'ours';
		async function read(command,args){
			commands.push({command,args});
			if(command==='timedatectl'&&args[0]==='show')return 'Timezone=Europe/Prague\\nCanNTP='+(input.canNtp===false?'no':'yes')+'\\nNTP=no\\nNTPSynchronized=no\\n';
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

describe('Linux NTP status while timesyncd is stopped', () => {
	it.each([
		[OWN_CONFIG, 'saved.example.org'],
		[OVERRIDDEN_CONFIG, 'override.example.org'],
	] as const)('reads the effective configured server without activating the daemon', async (config, server) => {
		const result = await offlineStatus({ config });
		expect(result.status).toMatchObject({ ntpEnabled: false, ntpServer: server, capabilities: { setNtpServer: true } });
		expect(result.commands.filter(call => call.command === 'systemd-analyze')).toEqual([{ command: 'systemd-analyze', args: ['--no-pager', 'cat-config', 'systemd/timesyncd.conf'] }]);
	});

	it('keeps a live timesyncd server ahead of configuration and skips the extra read', async () => {
		const result = await offlineStatus({ config: OWN_CONFIG, runtime: 'ServerName=active.example.org\n' });
		expect(result.status.ntpServer).toBe('active.example.org');
		expect(result.commands.some(call => call.command === 'systemd-analyze')).toBe(false);
	});

	it.each(['foreign', 'unknown', 'masked'] as const)('does not trust a timesyncd drop-in when ownership is %s', async owner => {
		const result = await offlineStatus({ config: OWN_CONFIG, owner });
		expect(result.status.ntpServer).toBeNull();
		expect(result.commands.some(call => call.command === 'systemd-analyze')).toBe(false);
	});

	it.each([{ competing: true }, { canNtp: false }])('does not read a server for a host timesyncd cannot safely manage: %j', async options => {
		const result = await offlineStatus({ config: OWN_CONFIG, ...options });
		expect(result.status.ntpServer).toBeNull();
		expect(result.commands.some(call => call.command === 'systemd-analyze')).toBe(false);
	});

	it.each([null, '[Time]\nNTP="invalid.example.org"\n'])('returns unknown when effective configuration cannot be read or parsed', async config => {
		const result = await offlineStatus({ config });
		expect(result.status.ntpServer).toBeNull();
	});
});
