import { afterEach, describe, expect, it } from 'bun:test';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { classifyFailure, decodeCommandOutput, firstLine, getSystemTimeStatus, getTimezoneSource, hostDateParts, isSupportedPlatform, isValidNtpServer, listHostTimezones, listSystemTimezones, parseSystemsetupOnOff, parseSystemsetupValue, parseTimedatectlShow, type PlatformStatusReader, resetHostTimezones, resolveSystemExecutable, timezoneOffsetMinutes, parseYesNo, validateClockParts } from '../../src/system-time.ts';
import { ianaToWindowsTimezoneId, windowsSystemLibraryPath } from '../../src/system-time-windows.ts';

// ---------------------------------------------------------------------------
// Fixtures — real command output, only host-identifying values replaced with
// RFC5737 documentation addresses and example.org names.
// ---------------------------------------------------------------------------

/** `timedatectl show` on a systemd host with synchronisation on. */
const TIMEDATECTL_SHOW = 'Timezone=Europe/Prague\nLocalRTC=no\nCanNTP=yes\nNTP=yes\nNTPSynchronized=yes\nTimeUSec=Thu 2026-08-14 23:46:28 CEST\nRTCTimeUSec=Thu 2026-08-14 21:46:28 UTC\n';

/** `timedatectl show-timesync --all`. `NTPMessage` carries `=` inside its braces. */
const TIMEDATECTL_TIMESYNC = 'LinkNTPServers=\nSystemNTPServers=ntp1.example.org ntp2.example.org\nFallbackNTPServers=ntp3.example.org\nServerName=ntp1.example.org\nServerAddress=192.0.2.10\nRootDistanceMaxUSec=5s\nPollIntervalMinUSec=32s\nPollIntervalMaxUSec=34min 8s\nNTPMessage={ Leap=0, Version=4, Mode=4, Stratum=2, Precision=-24 }\nFrequency=1548911\n';

/** What every `systemsetup` subcommand prints to an unprivileged caller. */
const SYSTEMSETUP_DENIED = 'You need administrator access to run this tool... exiting!\n';

describe('isSupportedPlatform', () => {
	it('accepts the three platforms that have a backend', () => {
		expect(isSupportedPlatform('win32')).toBe(true);
		expect(isSupportedPlatform('linux')).toBe(true);
		expect(isSupportedPlatform('darwin')).toBe(true);
	});

	it('rejects every other platform', () => {
		for (const platform of ['freebsd', 'openbsd', 'sunos', 'aix', 'android', 'Linux', '']) expect(isSupportedPlatform(platform)).toBe(false);
	});
});

describe('trusted system executables', () => {
	it('maps every privileged helper to an absolute operating-system path', () => {
		expect(resolveSystemExecutable('linux', 'timedatectl')).toBe('/usr/bin/timedatectl');
		expect(resolveSystemExecutable('linux', 'systemctl')).toBe('/usr/bin/systemctl');
		expect(resolveSystemExecutable('darwin', '/usr/sbin/systemsetup')).toBe('/usr/sbin/systemsetup');
		expect(resolveSystemExecutable('win32', 'w32tm', 'D:\\Windows')).toBe('D:\\Windows\\System32\\w32tm.exe');
		expect(resolveSystemExecutable('win32', 'powershell', 'D:\\Windows')).toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
	});

	it('fails closed for a relative executable outside the allow-list', () => {
		expect(resolveSystemExecutable('linux', 'sh')).toBeNull();
		expect(resolveSystemExecutable('win32', 'cmd', 'C:\\Windows')).toBeNull();
	});

	it('loads Windows DLLs from System32 rather than the DLL search path', () => {
		expect(windowsSystemLibraryPath('icu.dll', 'D:\\Windows')).toBe('D:\\Windows\\System32\\icu.dll');
		expect(windowsSystemLibraryPath('advapi32.dll', 'D:\\Windows')).toBe('D:\\Windows\\System32\\advapi32.dll');
	});
});

describe('parseTimedatectlShow', () => {
	it('reads the bare key=value lines', () => {
		const map = parseTimedatectlShow(TIMEDATECTL_SHOW);
		expect(map['Timezone']).toBe('Europe/Prague');
		expect(map['CanNTP']).toBe('yes');
		expect(map['TimeUSec']).toBe('Thu 2026-08-14 23:46:28 CEST');
	});

	it('splits on the first = only, so a value may contain more of them', () => {
		expect(parseTimedatectlShow(TIMEDATECTL_TIMESYNC)['NTPMessage']).toBe('{ Leap=0, Version=4, Mode=4, Stratum=2, Precision=-24 }');
	});

	it('keeps an empty value rather than dropping the key', () => {
		expect(parseTimedatectlShow(TIMEDATECTL_TIMESYNC)['LinkNTPServers']).toBe('');
	});

	it('ignores lines without a key', () => {
		expect(parseTimedatectlShow('\n=orphan\nNTP=no\n')).toEqual({ NTP: 'no' });
	});

	it('returns an empty map for empty or unparseable output', () => {
		expect(parseTimedatectlShow('')).toEqual({});
		expect(parseTimedatectlShow('Failed to query server: Access denied\n')).toEqual({});
	});
});

describe('parseYesNo', () => {
	it('maps the systemd literals', () => {
		expect(parseYesNo('yes')).toBe(true);
		expect(parseYesNo('no')).toBe(false);
	});

	it('returns null for a missing or unexpected value', () => {
		expect(parseYesNo(undefined)).toBeNull();
		expect(parseYesNo('maybe')).toBeNull();
		expect(parseYesNo('')).toBeNull();
		expect(parseYesNo('Yes')).toBeNull();
	});
});

describe('parseSystemsetupValue', () => {
	it('takes everything after the label', () => {
		expect(parseSystemsetupValue('Network Time Server: ntp.example.org\n')).toBe('ntp.example.org');
		expect(parseSystemsetupValue('Time Zone: Europe/Prague\n')).toBe('Europe/Prague');
	});

	it('keeps the colons inside an IPv6 server address', () => {
		expect(parseSystemsetupValue('Network Time Server: 2001:db8::1\n')).toBe('2001:db8::1');
	});

	it('returns null for an error line without a label', () => {
		expect(parseSystemsetupValue(SYSTEMSETUP_DENIED)).toBeNull();
	});

	it('returns null for empty output or a label with no value', () => {
		expect(parseSystemsetupValue('')).toBeNull();
		expect(parseSystemsetupValue('   \n')).toBeNull();
		expect(parseSystemsetupValue('Network Time Server: \n')).toBeNull();
	});
});

describe('parseSystemsetupOnOff', () => {
	it('maps On and Off whatever the case', () => {
		expect(parseSystemsetupOnOff('Network Time: On\n')).toBe(true);
		expect(parseSystemsetupOnOff('Network Time: Off\n')).toBe(false);
		expect(parseSystemsetupOnOff('Network Time: on\n')).toBe(true);
	});

	it('returns null for anything else', () => {
		expect(parseSystemsetupOnOff('Network Time: dunno\n')).toBeNull();
		expect(parseSystemsetupOnOff(SYSTEMSETUP_DENIED)).toBeNull();
		expect(parseSystemsetupOnOff('')).toBeNull();
	});
});

describe('decodeCommandOutput', () => {
	/**
	 * `w32tm /config` refusing an unelevated caller on a Czech host, captured byte for
	 * byte. 0xFD is `ř` and 0xA1 is `í` in cp852 — neither is a valid UTF-8 sequence on
	 * its own, so reading these bytes as UTF-8 turns both into U+FFFD.
	 */
	const CP852_DENIAL = Uint8Array.from(Buffer.from('54686520666f6c6c6f77696e67206572726f72206f636375727265643a2050fda1737475702062796c206f646570fd656e2e20283078383030373030303529', 'hex'));

	it('reads UTF-8 off Windows, where the child already speaks it', () => {
		expect(decodeCommandOutput(Buffer.from('Přístup byl odepřen.', 'utf8'), 'linux')).toBe('Přístup byl odepřen.');
	});

	it('leaves an empty output empty', () => {
		expect(decodeCommandOutput(new Uint8Array(0), 'win32')).toBe('');
	});

	it('keeps plain ASCII identical whichever code page the host has', () => {
		expect(decodeCommandOutput(Buffer.from('[SC] OpenService FAILED 5:', 'utf8'), 'win32')).toBe('[SC] OpenService FAILED 5:');
	});

	it.skipIf(process.platform !== 'win32')('decodes an OEM code page rather than mangling it into replacement characters', () => {
		const decoded = decodeCommandOutput(CP852_DENIAL, 'win32');
		// Whatever this host's console code page is, the ASCII skeleton and the HRESULT
		// classifyFailure matches on must survive intact.
		expect(decoded).toContain('The following error occurred');
		expect(decoded).toContain('0x80070005');
		expect(classifyFailure('win32', 1, decoded)).toBe('permission-denied');
		// On a cp852 host the accented characters come back as themselves. Elsewhere the
		// bytes mean something else, so only assert that nothing was lost to U+FFFD.
		if (decoded.includes('Přístup')) expect(decoded).toContain('odepřen');
		else expect(decoded).not.toContain('�');
	});

	it('would have produced replacement characters without the code-page conversion', () => {
		expect(Buffer.from(CP852_DENIAL).toString('utf8')).toContain('�');
	});
});

describe('firstLine', () => {
	it('takes the first non-blank line, trimmed', () => {
		expect(firstLine('\r\n\n   \n  [SC] OpenService FAILED 5:  \r\n\r\nAccess is denied.\r\n')).toBe('[SC] OpenService FAILED 5:');
	});

	it('returns null when there is nothing to report', () => {
		expect(firstLine('')).toBeNull();
		expect(firstLine('\n \t \r\n')).toBeNull();
	});
});

describe('classifyFailure', () => {
	it('detects a Windows access denial by code, not by the localized message', () => {
		expect(classifyFailure('win32', -2147024891, 'The following error occurred: Pristup byl odepren. (0x80070005)')).toBe('permission-denied');
		expect(classifyFailure('win32', 1314, '')).toBe('permission-denied');
		// sc.exe surfaces the Win32 code directly, with the text localized away
		expect(classifyFailure('win32', 5, '[SC] OpenService FAILED 5:\r\n\r\nPristup byl odepren.')).toBe('permission-denied');
	});

	it('reads the HRESULT out of the message when the exit code says nothing', () => {
		// w32tm writes its error to stdout and can still exit 1 or even 0.
		expect(classifyFailure('win32', 1, 'The following error occurred: Access is denied. (0x80070005)')).toBe('permission-denied');
		expect(classifyFailure('win32', 0, 'The computer did not resync: 0x80070522')).toBe('permission-denied');
	});

	it('does not guess at a localized Windows message that carries no code', () => {
		expect(classifyFailure('win32', 1, 'Pristup byl odepren.')).toBe('error');
	});

	/**
	 * ERROR_NOT_SUPPORTED is an ordinary failure of one call, not a statement that the
	 * platform lacks the feature. Reporting it as unsupported would tell the user to
	 * stop trying on a host where the very next attempt might work.
	 */
	it('does not read a plain Windows ERROR_NOT_SUPPORTED as an unsupported platform', () => {
		expect(classifyFailure('win32', 1, 'The following error occurred: The request is not supported. (0x80070032)')).toBe('error');
	});

	it('still detects the NTP-not-supported wording it is meant for', () => {
		expect(classifyFailure('linux', 1, 'Failed to set ntp: NTP not supported')).toBe('unsupported');
	});

	it('detects a polkit denial on linux', () => {
		expect(classifyFailure('linux', 1, 'Failed to set time: Interactive authentication required.')).toBe('permission-denied');
	});

	it('detects the other unprivileged linux wordings', () => {
		expect(classifyFailure('linux', 1, 'Failed to set time: Access denied')).toBe('permission-denied');
		expect(classifyFailure('linux', 1, 'Failed to set time: Operation not permitted')).toBe('permission-denied');
		expect(classifyFailure('linux', 1, 'timedatectl must be run as root')).toBe('permission-denied');
	});

	it('detects the macOS root requirement', () => {
		expect(classifyFailure('darwin', 1, SYSTEMSETUP_DENIED)).toBe('permission-denied');
	});

	it('separates the auto-sync conflict from a permission problem', () => {
		expect(classifyFailure('linux', 1, 'Failed to set time: Automatic time synchronization is enabled')).toBe('auto-sync-enabled');
	});

	it('matches whatever case the tool shouted in', () => {
		expect(classifyFailure('linux', 1, 'FAILED TO SET TIME: AUTOMATIC TIME SYNCHRONIZATION IS ENABLED')).toBe('auto-sync-enabled');
	});

	it('reports a missing sync service as unsupported', () => {
		expect(classifyFailure('linux', 1, 'Failed to set ntp: NTP not supported')).toBe('unsupported');
	});

	it('classifies a failure that carried no exit code at all', () => {
		expect(classifyFailure('win32', null, '')).toBe('error');
		expect(classifyFailure('linux', null, 'Failed to set time: Access denied')).toBe('permission-denied');
	});

	it('falls back to a generic error', () => {
		expect(classifyFailure('linux', 1, "Failed to set time zone: Invalid time zone 'Foo/Bar'")).toBe('error');
		expect(classifyFailure('darwin', 1, 'setnetworktimeserver: unexpected failure')).toBe('error');
		expect(classifyFailure('win32', 9009, 'The system cannot find the file specified.')).toBe('error');
	});
});

describe('validateClockParts', () => {
	it('accepts a valid time', () => {
		expect(validateClockParts(23, 46, 28)).toBeNull();
		expect(validateClockParts(0, 0, 0)).toBeNull();
		expect(validateClockParts(23, 59, 59)).toBeNull();
	});

	it('rejects out-of-range and non-integer parts', () => {
		expect(validateClockParts(24, 0, 0)).toBe('hours must be between 0 and 23');
		expect(validateClockParts(-1, 0, 0)).toBe('hours must be between 0 and 23');
		expect(validateClockParts(1, 60, 0)).toBe('minutes must be between 0 and 59');
		expect(validateClockParts(1, -1, 0)).toBe('minutes must be between 0 and 59');
		expect(validateClockParts(1, 0, 60)).toBe('seconds must be between 0 and 59');
		expect(validateClockParts(1, 0, -1)).toBe('seconds must be between 0 and 59');
		expect(validateClockParts(1.5, 0, 0)).toBe('hours must be an integer');
		expect(validateClockParts(1, 0, Number.NaN)).toBe('seconds must be an integer');
		expect(validateClockParts(1, Number.POSITIVE_INFINITY, 0)).toBe('minutes must be an integer');
	});

	it('names the first offending part only', () => {
		expect(validateClockParts(99, 99, 99)).toBe('hours must be between 0 and 23');
	});
});

describe('isValidNtpServer', () => {
	it('accepts host names and IP literals', () => {
		expect(isValidNtpServer('ntp.example.org')).toBe(true);
		expect(isValidNtpServer('192.0.2.10')).toBe(true);
		expect(isValidNtpServer('2001:db8::1')).toBe(true);
		expect(isValidNtpServer('0.pool.ntp.org')).toBe(true);
		expect(isValidNtpServer('a')).toBe(true);
	});

	/**
	 * Accepted by `net.isIP()` and useless as a peer: nothing answers, so the daemon just
	 * stops synchronising while the UI shows a configured server and no error at all.
	 */
	it('rejects the unspecified address and the broadcast address', () => {
		expect(isValidNtpServer('0.0.0.0')).toBe(false);
		expect(isValidNtpServer('255.255.255.255')).toBe(false);
		expect(isValidNtpServer('::')).toBe(false);
		expect(isValidNtpServer('0:0:0:0:0:0:0:0')).toBe(false);
		// Still a perfectly good peer, digits and all.
		expect(isValidNtpServer('192.0.2.0')).toBe(true);
		expect(isValidNtpServer('::1')).toBe(true);
	});

	/**
	 * The way round the check above, by either of the two routes a scoped address can take.
	 * Node's `net.isIP()` rejects the scope and sends the value down the zone-index branch,
	 * which only asked whether the part before the `%` parses; Bun's accepts it and hands
	 * the whole string, suffix and all, to a match that only knew about digits and colons.
	 */
	it('rejects the unspecified address with a scope index on it', () => {
		expect(isValidNtpServer('::%eth0')).toBe(false);
		expect(isValidNtpServer('0:0:0:0:0:0:0:0%eth0')).toBe(false);
		expect(isValidNtpServer('0000:0000:0000:0000:0000:0000:0000:0000%1')).toBe(false);
		// A scope on an address that IS a peer stays valid.
		expect(isValidNtpServer('fe80::1%eth0')).toBe(true);
	});

	it('rejects whitespace and shell metacharacters', () => {
		expect(isValidNtpServer('ntp.example.org; rm -rf /')).toBe(false);
		expect(isValidNtpServer('ntp.example.org two.example.org')).toBe(false);
		expect(isValidNtpServer('ntp.example.org\ttwo.example.org')).toBe(false);
		expect(isValidNtpServer('ntp.example.org\nNTP=evil.example.org')).toBe(false);
		expect(isValidNtpServer('$(whoami)')).toBe(false);
		expect(isValidNtpServer('a`b`c')).toBe(false);
		expect(isValidNtpServer('ntp.example.org && shutdown')).toBe(false);
		expect(isValidNtpServer('ntp.example.org|tee')).toBe(false);
		expect(isValidNtpServer('../../etc/passwd')).toBe(false);
		expect(isValidNtpServer('')).toBe(false);
		expect(isValidNtpServer('-leading.example.org')).toBe(false);
		expect(isValidNtpServer('trailing.example.org-')).toBe(false);
	});

	it('accepts an explicit root dot and a zone index', () => {
		expect(isValidNtpServer('ntp.example.org.')).toBe(true);
		expect(isValidNtpServer('fe80::1%eth0')).toBe(true);
	});

	it('rejects an IP literal that is out of range or malformed', () => {
		expect(isValidNtpServer('192.0.2.999')).toBe(false);
		expect(isValidNtpServer('1.2.3.4.5')).toBe(false);
		expect(isValidNtpServer('2001:db8:::1')).toBe(false);
		// `::` used to be asserted as valid here; it parses, but see the unspecified-address
		// test above for why it is not an address anything can synchronise from.
		expect(isValidNtpServer('2001:db8::1')).toBe(true);
	});

	it('rejects a name with an empty or over-long label', () => {
		expect(isValidNtpServer('ntp..example.org')).toBe(false);
		expect(isValidNtpServer('.example.org')).toBe(false);
		expect(isValidNtpServer(`${'a'.repeat(64)}.example.org`)).toBe(false);
		expect(isValidNtpServer(`${'a'.repeat(63)}.example.org`)).toBe(true);
	});

	it('rejects a name longer than a DNS name can be', () => {
		// 63-char labels: four of them plus the separators is 255 characters.
		const long = Array(4).fill('a'.repeat(63)).join('.');
		expect(long.length).toBe(255);
		expect(isValidNtpServer(long)).toBe(false);
		// A single label may not exceed 63 characters either, whatever the total length.
		expect(isValidNtpServer('a'.repeat(253))).toBe(false);
		expect(isValidNtpServer('a'.repeat(63))).toBe(true);
	});

	it('rejects a stray colon or zone index that is not part of an IPv6 literal', () => {
		expect(isValidNtpServer('a:b:c')).toBe(false);
		expect(isValidNtpServer('ntp.example.org:123')).toBe(false);
		expect(isValidNtpServer('ntp.example.org%eth0')).toBe(false);
		expect(isValidNtpServer('fe80::1%')).toBe(false);
	});
});

describe('timezoneOffsetMinutes', () => {
	const SUMMER = new Date('2026-08-14T12:00:00Z');
	const WINTER = new Date('2026-01-14T12:00:00Z');

	it('counts minutes to add to UTC, positive east of Greenwich', () => {
		expect(timezoneOffsetMinutes('UTC', SUMMER)).toBe(0);
		expect(timezoneOffsetMinutes('Europe/Prague', SUMMER)).toBe(120);
		expect(timezoneOffsetMinutes('America/New_York', SUMMER)).toBe(-240);
	});

	it('follows daylight saving for the given instant', () => {
		expect(timezoneOffsetMinutes('Europe/Prague', WINTER)).toBe(60);
		expect(timezoneOffsetMinutes('America/New_York', WINTER)).toBe(-300);
	});

	it('handles zones that are not a whole number of hours from UTC', () => {
		expect(timezoneOffsetMinutes('Asia/Kolkata', SUMMER)).toBe(330);
		expect(timezoneOffsetMinutes('Asia/Kathmandu', SUMMER)).toBe(345);
	});

	it('returns null for a zone the runtime does not know', () => {
		expect(timezoneOffsetMinutes('Mars/Olympus_Mons', SUMMER)).toBeNull();
		expect(timezoneOffsetMinutes('', SUMMER)).toBeNull();
	});

	/**
	 * The reason the offset is computed for the NAMED zone: once the host's zone is read
	 * from the OS it can differ from the process's, and `Date.getTimezoneOffset()` would
	 * answer for the process, putting the displayed clock hours out.
	 */
	it('answers for the zone it was given, not for the process', () => {
		const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const other = own === 'Asia/Tokyo' ? 'America/Denver' : 'Asia/Tokyo';
		expect(timezoneOffsetMinutes(other, SUMMER)).not.toBe(timezoneOffsetMinutes(own, SUMMER) ?? 0);
	});
});

describe('getSystemTimeStatus (live, read-only)', () => {
	/**
	 * The invariant that finding "the offset is the process's, the zone is the host's"
	 * would break: whatever zone the status reports, the offset next to it has to be that
	 * zone's, or the clock the UI reconstructs from the pair is hours out.
	 */
	it('reports an offset that belongs to the timezone it reports', async () => {
		const status = await getSystemTimeStatus();
		expect(status.timezone.length).toBeGreaterThan(0);
		expect(timezoneOffsetMinutes(status.timezone, new Date(status.nowMs))).not.toBeNull();
		expect(status.utcOffsetMinutes).toBe(timezoneOffsetMinutes(status.timezone, new Date(status.nowMs)) ?? Number.NaN);
	});
});

describe('hostDateParts', () => {
	/**
	 * The bug this exists for: a host just past midnight, read from a process running two
	 * hours behind it. The process still says yesterday, and writing the time onto that
	 * date moves the host's clock back a full day.
	 */
	it('takes the date from the host zone, not from UTC or the process', () => {
		const justPastMidnightInPrague = Date.UTC(2026, 7, 12, 22, 10, 0);
		expect(hostDateParts(justPastMidnightInPrague, 120)).toEqual({ year: 2026, month: 8, day: 13 });
		// The same instant, on a host west of Greenwich: still the previous day there.
		expect(hostDateParts(justPastMidnightInPrague, -300)).toEqual({ year: 2026, month: 8, day: 12 });
	});

	it('rolls the month and the year over with the date', () => {
		expect(hostDateParts(Date.UTC(2026, 11, 31, 23, 30, 0), 60)).toEqual({ year: 2027, month: 1, day: 1 });
	});
});

describe('getSystemTimeStatus clock sampling', () => {
	/**
	 * The status read is up to six child processes. Taking the clock before them ships a
	 * time that is already that old, and the UI counts on from there — permanently behind
	 * the host by however long the read took.
	 */
	it('samples the clock after the host has been read, not before', async () => {
		const slowRead: PlatformStatusReader = async () => {
			await new Promise(resolve => setTimeout(resolve, 30));
			return { ntpEnabled: false, ntpSynchronized: null, ntpServer: null, timezone: 'Europe/Prague', capabilities: { setClock: true, setTimezone: true, setNtpServer: true, setNtpEnabled: true } };
		};
		const before = Date.now();
		const status = await getSystemTimeStatus(slowRead);
		expect(status.nowMs).toBeGreaterThanOrEqual(before + 25);
		expect(status.nowMs).toBeLessThanOrEqual(Date.now());
	});
});

describe('listSystemTimezones', () => {
	it('accepts UTC when the runtime canonical list omits that valid timezone', async () => {
		const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../helpers/system-time-timezones.js')], { stdout: 'pipe', stderr: 'pipe' });
		const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
			expect(exitCode).toBe(0);
			expect(stderr).toBe('');
			const result = JSON.parse(stdout);
			expect(result).toMatchObject({ canonicalIncludesUtc: false, utcResolves: true, utcAvailable: true, result: { success: true, outcome: 'ok' } });
			expect(result.calls).toHaveLength(1);
			expect(result.calls[0].args).toContain('UTC');
		} finally {
			clearTimeout(deadline);
			if (child.exitCode === null) {
				child.kill('SIGKILL');
				await child.exited;
			}
		}
	});

	it('returns the IANA list the runtime resolves against', () => {
		const zones = listSystemTimezones();
		expect(zones.length).toBeGreaterThan(100);
		expect(zones).toContain('Europe/Prague');
		expect(zones).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
	});

	it('reports where that list came from', () => {
		expect(getTimezoneSource()).toBe(listSystemTimezones().length > 0 ? 'intl' : 'unavailable');
		expect(getTimezoneSource()).toBe('intl');
	});
});
describe('listHostTimezones', () => {
	afterEach(() => resetHostTimezones());

	it('drops the zones Windows has no identifier for', () => {
		resetHostTimezones();
		const unconvertible = new Set(['America/Ciudad_Juarez', 'Antarctica/Troll', 'Asia/Urumqi']);
		const zones = listHostTimezones(
			'win32',
			zone => (unconvertible.has(zone) ? null : 'Some Standard Time'),
			() => true
		);
		for (const zone of unconvertible) expect(zones).not.toContain(zone);
		expect(zones).toContain('Europe/Prague');
		expect(zones.length).toBe(listSystemTimezones().length - [...unconvertible].filter(zone => listSystemTimezones().includes(zone)).length);
	});

	it('leaves the runtime list alone off Windows, where the identifier is used as-is', () => {
		resetHostTimezones();
		expect(
			listHostTimezones(
				'linux',
				() => null,
				() => true,
				null
			)
		).toEqual(listSystemTimezones());
	});

	it('keeps the whole list on a Windows without ICU rather than offering nothing', () => {
		resetHostTimezones();
		expect(
			listHostTimezones(
				'win32',
				() => null,
				() => false
			)
		).toEqual(listSystemTimezones());
	});

	// The POSIX half of the same rule. ICU names zones the host's tzdata need not carry:
	// on a systemd host 18 of 445 were refused by `timedatectl set-timezone`, `Asia/Calcutta`
	// and `Europe/Kiev` among them, each one reproducing the same half-applied save.
	it('drops the zones a POSIX host has no tzdata file for', () => {
		resetHostTimezones();
		const legacy = new Set(['Asia/Calcutta', 'Europe/Kiev', 'America/Buenos_Aires']);
		const zones = listHostTimezones(
			'linux',
			() => 'unused',
			() => true,
			zone => !legacy.has(zone)
		);
		for (const zone of legacy) expect(zones).not.toContain(zone);
		expect(zones).toContain('Europe/Prague');
	});

	it('offers the runtime list unfiltered where the host has no zoneinfo directory', () => {
		resetHostTimezones();
		expect(
			listHostTimezones(
				'linux',
				() => null,
				() => true,
				null
			)
		).toEqual(listSystemTimezones());
	});

	it.skipIf(process.platform === 'win32')('offers only zones this host has tzdata for', () => {
		resetHostTimezones();
		const offered = listHostTimezones();
		expect(offered.length).toBeGreaterThan(100);
		for (const zone of offered) expect(existsSync(join('/usr/share/zoneinfo', zone))).toBe(true);
	});

	it.skipIf(process.platform !== 'win32')('offers only zones this host can really be set to', () => {
		resetHostTimezones();
		const offered = listHostTimezones();
		expect(offered.length).toBeGreaterThan(100);
		expect(offered.every(zone => ianaToWindowsTimezoneId(zone) !== null)).toBe(true);
		// The point of the filter: the runtime does offer zones that convert to nothing.
		expect(listSystemTimezones().some(zone => ianaToWindowsTimezoneId(zone) === null)).toBe(true);
	});
});
