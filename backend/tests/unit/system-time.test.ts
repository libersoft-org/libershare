import { describe, expect, it } from 'bun:test';
import { buildSetClockCommands, buildSetNtpEnabledCommands, buildSetNtpServerCommands, buildSetTimezoneCommands, buildTimesyncdDropIn, classifyFailure, clockWriteRefusal, firstLine, getSystemTimeStatus, getTimezoneSource, isSupportedPlatform, isValidNtpServer, listSystemTimezones, parseRegValue, parseServiceRunning, parseSystemsetupOnOff, parseSystemsetupValue, parseTimedatectlShow, parseTimesyncServer, parseUnitInstalled, parseWindowsNtpServer, parseWindowsSyncStatus, parseYesNo, runAll, setSystemClock, setSystemNtpEnabled, setSystemNtpServer, setSystemTimezone, type CommandRunner, type RunOutcome, type SystemCommand, validateClockParts } from '../../src/system-time.ts';
import { canConvertTimezoneId, ianaToWindowsTimezoneId } from '../../src/system-time-windows.ts';
import type { SystemTimeStatus } from '@shared';

// ---------------------------------------------------------------------------
// Fixtures — real command output, only host-identifying values replaced with
// RFC5737 documentation addresses and example.org names.
// ---------------------------------------------------------------------------

/** `timedatectl show` on a systemd host with synchronisation on. */
const TIMEDATECTL_SHOW = 'Timezone=Europe/Prague\nLocalRTC=no\nCanNTP=yes\nNTP=yes\nNTPSynchronized=yes\nTimeUSec=Thu 2026-08-14 23:46:28 CEST\nRTCTimeUSec=Thu 2026-08-14 21:46:28 UTC\n';

/** `timedatectl show-timesync --all`. `NTPMessage` carries `=` inside its braces. */
const TIMEDATECTL_TIMESYNC = 'LinkNTPServers=\nSystemNTPServers=ntp1.example.org ntp2.example.org\nFallbackNTPServers=ntp3.example.org\nServerName=ntp1.example.org\nServerAddress=192.0.2.10\nRootDistanceMaxUSec=5s\nPollIntervalMinUSec=32s\nPollIntervalMaxUSec=34min 8s\nNTPMessage={ Leap=0, Version=4, Mode=4, Stratum=2, Precision=-24 }\nFrequency=1548911\n';

/** `reg query HKLM\\...\\W32Time\\Parameters`, CRLF and mixed value kinds as captured. */
const REG_QUERY_PARAMS = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\W32Time\\Parameters\r\n    NtpServer    REG_SZ    time.windows.com,0x9\r\n    ServiceDll    REG_EXPAND_SZ    %systemroot%\\system32\\w32time.dll\r\n    ServiceDllUnloadOnStop    REG_DWORD    0x1\r\n    ServiceMain    REG_SZ    SvchostEntry_W32Time\r\n    Type    REG_SZ    NTP\r\n\r\n';

/** `sc query w32time` for a running service, trailing spaces included. */
const SC_QUERY_RUNNING = '\r\nSERVICE_NAME: w32time \r\n        TYPE               : 30  WIN32  \r\n        STATE              : 4  RUNNING \r\n                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)\r\n        WIN32_EXIT_CODE    : 0  (0x0)\r\n        SERVICE_EXIT_CODE  : 0  (0x0)\r\n        CHECKPOINT         : 0x0\r\n        WAIT_HINT          : 0x0\r\n';

/** The same service stopped. Other fields carry a 4, which must not be read as the state. */
const SC_QUERY_STOPPED = '\r\nSERVICE_NAME: w32time \r\n        TYPE               : 30  WIN32  \r\n        STATE              : 1  STOPPED \r\n        WIN32_EXIT_CODE    : 1077  (0x435)\r\n        SERVICE_EXIT_CODE  : 4  (0x4)\r\n        CHECKPOINT         : 0x4\r\n        WAIT_HINT          : 0x0\r\n';

/** `w32tm /query /status` on a host with a localized date format: only the timestamp is translated. */
const W32TM_STATUS = 'Leap Indicator: 0(no warning)\r\nStratum: 5 (secondary reference - syncd by (S)NTP)\r\nPrecision: -23 (119.209ns per tick)\r\nRoot Delay: 0.0161789s\r\nRoot Dispersion: 7.7770884s\r\nReferenceId: 0xC0000210 (source IP:  192.0.2.16)\r\nLast Successful Sync Time: 14.08.2026 20:55:55\r\nSource: ntp1.example.org,0x9 \r\nPoll Interval: 15 (32768s)\r\n';

/** `w32tm /query /status` on a clock that has never been synchronised. */
const W32TM_STATUS_NEVER = 'Leap Indicator: 3(not synchronized)\r\nStratum: 0 (unspecified)\r\nLast Successful Sync Time: unspecified\r\nSource: Local CMOS Clock\r\n';

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

describe('parseTimesyncServer', () => {
	it('prefers the peer actually in use over the configured list', () => {
		const out = 'SystemNTPServers=ntp1.example.org ntp2.example.org\nFallbackNTPServers=ntp3.example.org\nServerName=ntp9.example.org\nServerAddress=192.0.2.10\n';
		expect(parseTimesyncServer(out)).toBe('ntp9.example.org');
	});

	it('reads the peer out of full show-timesync output', () => {
		expect(parseTimesyncServer(TIMEDATECTL_TIMESYNC)).toBe('ntp1.example.org');
	});

	it('falls back to the first configured server', () => {
		expect(parseTimesyncServer('SystemNTPServers=ntp1.example.org ntp2.example.org\nServerName=\n')).toBe('ntp1.example.org');
	});

	it('falls back past an empty configured list to the link and fallback ones', () => {
		expect(parseTimesyncServer('SystemNTPServers=\nLinkNTPServers=ntp-dhcp.example.org\nFallbackNTPServers=ntp3.example.org\n')).toBe('ntp-dhcp.example.org');
		expect(parseTimesyncServer('SystemNTPServers=\nLinkNTPServers=\nFallbackNTPServers=ntp3.example.org ntp4.example.org\n')).toBe('ntp3.example.org');
	});

	it('returns null when nothing is configured', () => {
		expect(parseTimesyncServer('SystemNTPServers=\nServerName=\n')).toBeNull();
		expect(parseTimesyncServer('')).toBeNull();
	});
});

describe('parseRegValue', () => {
	it('extracts the named value from real reg query output', () => {
		expect(parseRegValue(REG_QUERY_PARAMS, 'NtpServer')).toBe('time.windows.com,0x9');
		expect(parseRegValue(REG_QUERY_PARAMS, 'Type')).toBe('NTP');
	});

	it('handles the other value kinds sitting on the same key', () => {
		expect(parseRegValue(REG_QUERY_PARAMS, 'ServiceDllUnloadOnStop')).toBe('0x1');
		expect(parseRegValue(REG_QUERY_PARAMS, 'ServiceDll')).toBe('%systemroot%\\system32\\w32time.dll');
	});

	it('does not match on a prefix of the name', () => {
		expect(parseRegValue(REG_QUERY_PARAMS, 'Ntp')).toBeNull();
		expect(parseRegValue(REG_QUERY_PARAMS, 'Service')).toBeNull();
	});

	it('returns null for an absent entry, empty output or an error message', () => {
		expect(parseRegValue(REG_QUERY_PARAMS, 'Missing')).toBeNull();
		expect(parseRegValue('', 'NtpServer')).toBeNull();
		expect(parseRegValue('ERROR: The system was unable to find the specified registry key or value.\r\n', 'NtpServer')).toBeNull();
	});
});

describe('parseWindowsNtpServer', () => {
	it('strips the peer flags and keeps the first host', () => {
		expect(parseWindowsNtpServer('ntp1.example.org,0x9 ntp2.example.org,0x9')).toBe('ntp1.example.org');
	});

	it('reads the value the registry parser handed it', () => {
		expect(parseWindowsNtpServer(parseRegValue(REG_QUERY_PARAMS, 'NtpServer'))).toBe('time.windows.com');
	});

	it('keeps a bare host that carries no flags', () => {
		expect(parseWindowsNtpServer('ntp1.example.org')).toBe('ntp1.example.org');
	});

	it('returns null when the registry value is missing, empty or flags only', () => {
		expect(parseWindowsNtpServer(null)).toBeNull();
		expect(parseWindowsNtpServer('   ')).toBeNull();
		expect(parseWindowsNtpServer(',0x9')).toBeNull();
	});
});

describe('parseServiceRunning', () => {
	it('reads a running service out of real sc query output', () => {
		expect(parseServiceRunning(SC_QUERY_RUNNING)).toBe(true);
	});

	it('matches the numeric state, not the localized word', () => {
		expect(parseServiceRunning('        STATE              : 4  SPUSTENO\n')).toBe(true);
	});

	it('is false for a stopped service whose other fields contain a 4', () => {
		expect(parseServiceRunning(SC_QUERY_STOPPED)).toBe(false);
	});

	it('is false for empty output', () => {
		expect(parseServiceRunning('')).toBe(false);
	});
});

describe('parseWindowsSyncStatus', () => {
	it('reports a synchronised clock from a localized timestamp', () => {
		expect(parseWindowsSyncStatus(W32TM_STATUS)).toBe(true);
	});

	it('reports a never-synchronised clock', () => {
		expect(parseWindowsSyncStatus(W32TM_STATUS_NEVER)).toBe(false);
	});

	it('returns null when the field is absent or has no value', () => {
		expect(parseWindowsSyncStatus('Stratum: 5\r\n')).toBeNull();
		expect(parseWindowsSyncStatus('Last Successful Sync Time: \r\n')).toBeNull();
		expect(parseWindowsSyncStatus('')).toBeNull();
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

	it('rejects a name longer than a DNS name can be', () => {
		expect(isValidNtpServer(`${'a'.repeat(253)}`)).toBe(true);
		expect(isValidNtpServer(`${'a'.repeat(254)}`)).toBe(false);
	});
});

const AT = { year: 2026, month: 8, day: 14, hours: 23, minutes: 46, seconds: 28 };

describe('buildSetClockCommands', () => {
	it('builds the linux argv with a full local timestamp', () => {
		expect(buildSetClockCommands('linux', AT)).toEqual([{ cmd: 'timedatectl', args: ['set-time', '2026-08-14 23:46:28'] }]);
	});

	it('sends only the time on macOS, leaving the date alone', () => {
		expect(buildSetClockCommands('darwin', AT)).toEqual([{ cmd: '/usr/sbin/systemsetup', args: ['-settime', '23:46:28'] }]);
	});

	it('builds the windows argv with an unambiguous ISO timestamp', () => {
		expect(buildSetClockCommands('win32', AT)).toEqual([{ cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', "Set-Date -Date '2026-08-14T23:46:28'"] }]);
	});

	it('zero-pads single-digit parts', () => {
		expect(buildSetClockCommands('linux', { year: 2026, month: 1, day: 2, hours: 3, minutes: 4, seconds: 5 })[0]?.args[1]).toBe('2026-01-02 03:04:05');
		expect(buildSetClockCommands('darwin', { ...AT, hours: 0, minutes: 0, seconds: 0 })[0]?.args[1]).toBe('00:00:00');
	});
});

describe('buildSetTimezoneCommands', () => {
	it('passes the IANA identifier straight through on linux and macOS', () => {
		expect(buildSetTimezoneCommands('linux', 'Europe/Prague', null)).toEqual([{ cmd: 'timedatectl', args: ['set-timezone', 'Europe/Prague'] }]);
		expect(buildSetTimezoneCommands('darwin', 'Europe/Prague', null)).toEqual([{ cmd: '/usr/sbin/systemsetup', args: ['-settimezone', 'Europe/Prague'] }]);
	});

	it('uses the converted identifier on windows', () => {
		expect(buildSetTimezoneCommands('win32', 'Europe/Prague', 'Central Europe Standard Time')).toEqual([{ cmd: 'tzutil', args: ['/s', 'Central Europe Standard Time'] }]);
	});

	it('yields no command on windows without a converted identifier', () => {
		expect(buildSetTimezoneCommands('win32', 'Europe/Prague', null)).toEqual([]);
	});
});

describe('buildTimesyncdDropIn', () => {
	it('writes a [Time] section with the server', () => {
		expect(buildTimesyncdDropIn('ntp.example.org')).toBe('[Time]\nNTP=ntp.example.org\n');
	});
});

describe('buildSetNtpServerCommands', () => {
	it('only restarts the daemon on linux, where the address lives in the drop-in', () => {
		expect(buildSetNtpServerCommands('linux', 'ntp.example.org', true)).toEqual([{ cmd: 'systemctl', args: ['restart', 'systemd-timesyncd'] }]);
	});

	/**
	 * `systemctl restart` starts a stopped unit. Running it while the user has
	 * synchronisation switched off would re-arm the daemon and let it step the clock
	 * they are about to set by hand — the drop-in on disk is the whole change here.
	 */
	it('runs nothing on linux while synchronisation is off', () => {
		expect(buildSetNtpServerCommands('linux', 'ntp.example.org', false)).toEqual([]);
	});

	it('configures the peer and resyncs on windows regardless of the sync state', () => {
		const expected = [
			{ cmd: 'w32tm', args: ['/config', '/manualpeerlist:ntp.example.org,0x9', '/syncfromflags:manual', '/update'] },
			{ cmd: 'w32tm', args: ['/resync'] },
		];
		expect(buildSetNtpServerCommands('win32', 'ntp.example.org', true)).toEqual(expected);
		expect(buildSetNtpServerCommands('win32', 'ntp.example.org', false)).toEqual(expected);
	});

	it('sets the single supported server on macOS', () => {
		expect(buildSetNtpServerCommands('darwin', 'ntp.example.org', true)).toEqual([{ cmd: '/usr/sbin/systemsetup', args: ['-setnetworktimeserver', 'ntp.example.org'] }]);
	});
});

describe('parseUnitInstalled', () => {
	const HEADER = 'UNIT FILE                 STATE     PRESET';

	it('accepts an installed unit', () => {
		expect(parseUnitInstalled(`${HEADER}\nsystemd-timesyncd.service enabled   enabled\n\n1 unit files listed.`, 'systemd-timesyncd.service')).toBe(true);
	});

	it('accepts a disabled unit — the drop-in still applies when it is started', () => {
		expect(parseUnitInstalled(`${HEADER}\nsystemd-timesyncd.service disabled  disabled\n\n1 unit files listed.`, 'systemd-timesyncd.service')).toBe(true);
	});

	it('rejects a masked unit, which can never start', () => {
		expect(parseUnitInstalled(`${HEADER}\nsystemd-timesyncd.service masked    disabled\n\n1 unit files listed.`, 'systemd-timesyncd.service')).toBe(false);
	});

	it('rejects a host without the unit, e.g. one running chrony', () => {
		expect(parseUnitInstalled(`${HEADER}\n\n0 unit files listed.`, 'systemd-timesyncd.service')).toBe(false);
	});
});

describe('buildSetNtpEnabledCommands', () => {
	it('is a single switch on linux and macOS', () => {
		expect(buildSetNtpEnabledCommands('linux', true)).toEqual([{ cmd: 'timedatectl', args: ['set-ntp', 'true'] }]);
		expect(buildSetNtpEnabledCommands('linux', false)).toEqual([{ cmd: 'timedatectl', args: ['set-ntp', 'false'] }]);
		expect(buildSetNtpEnabledCommands('darwin', true)).toEqual([{ cmd: '/usr/sbin/systemsetup', args: ['-setusingnetworktime', 'on'] }]);
		expect(buildSetNtpEnabledCommands('darwin', false)).toEqual([{ cmd: '/usr/sbin/systemsetup', args: ['-setusingnetworktime', 'off'] }]);
	});

	it('sets the start mode, the running state and the sync type on windows', () => {
		// The /config step is what clears a registry Type of NoSync. Without it the
		// status read still reports synchronisation as off on such a host, and the
		// toggle looks like it did not stick.
		expect(buildSetNtpEnabledCommands('win32', true)).toEqual([
			{ cmd: 'sc', args: ['config', 'w32time', 'start=', 'auto'] },
			{ cmd: 'sc', args: ['start', 'w32time'], benignCodes: [1056] },
			{ cmd: 'w32tm', args: ['/config', '/syncfromflags:manual', '/update'] },
			{ cmd: 'w32tm', args: ['/resync'] },
		]);
		expect(buildSetNtpEnabledCommands('win32', false)).toEqual([
			{ cmd: 'sc', args: ['stop', 'w32time'], benignCodes: [1062] },
			{ cmd: 'sc', args: ['config', 'w32time', 'start=', 'disabled'] },
		]);
	});

	it('stops the service before disabling it, so the switch takes effect at once', () => {
		expect(buildSetNtpEnabledCommands('win32', false).map(c => c.args[0])).toEqual(['stop', 'config']);
	});

	it('marks only the service run-state steps as tolerable, never the ones carrying the change', () => {
		// A host whose service is already in the requested run state must still get its
		// sync type and start mode written, so those steps may not sit behind an abort.
		const tolerated = (enabled: boolean): string[] =>
			buildSetNtpEnabledCommands('win32', enabled)
				.filter(c => c.benignCodes !== undefined)
				.map(c => [c.cmd, ...c.args].join(' '));
		expect(tolerated(true)).toEqual(['sc start w32time']);
		expect(tolerated(false)).toEqual(['sc stop w32time']);
	});
});

/** Answer a fixed queue of outcomes and record what was asked for. */
function fakeRunner(outcomes: RunOutcome[]): { exec: CommandRunner; calls: string[] } {
	const calls: string[] = [];
	const queue = [...outcomes];
	const exec: CommandRunner = async (cmd, args) => {
		calls.push([cmd, ...args].join(' '));
		return queue.shift() ?? { kind: 'ok', output: '' };
	};
	return { exec, calls };
}

describe('runAll', () => {
	const DISABLE: SystemCommand[] = buildSetNtpEnabledCommands('win32', false);

	it('succeeds only once every command has exited 0', async () => {
		const { exec, calls } = fakeRunner([
			{ kind: 'ok', output: '' },
			{ kind: 'ok', output: '[SC] ChangeServiceConfig SUCCESS\r\n' },
		]);
		expect(await runAll('win32', DISABLE, exec)).toEqual({ success: true, outcome: 'ok', message: null });
		expect(calls).toEqual(['sc stop w32time', 'sc config w32time start= disabled']);
	});

	it('stops at the first failure and reports it as a denial with its first output line', async () => {
		const { exec, calls } = fakeRunner([{ kind: 'failed', code: 5, output: '[SC] OpenService FAILED 5:\r\n\r\nAccess is denied.\r\n' }]);
		expect(await runAll('win32', DISABLE, exec)).toEqual({ success: false, outcome: 'permission-denied', message: '[SC] OpenService FAILED 5:' });
		expect(calls).toEqual(['sc stop w32time']);
	});

	it('carries on past a step that only failed because it had nothing to do', async () => {
		// `sc start` exits 1056 when the service is already up. Aborting there would skip
		// the /config step that clears a NoSync sync type, and enabling would report a
		// failure on a host it could have fixed.
		const { exec, calls } = fakeRunner([
			{ kind: 'ok', output: '' },
			{ kind: 'failed', code: 1056, output: '[SC] StartService FAILED 1056:\r\n\r\nAn instance of the service is already running.\r\n' },
		]);
		expect(await runAll('win32', buildSetNtpEnabledCommands('win32', true), exec)).toEqual({ success: true, outcome: 'ok', message: null });
		expect(calls).toEqual(['sc config w32time start= auto', 'sc start w32time', 'w32tm /config /syncfromflags:manual /update', 'w32tm /resync']);
	});

	it('still reports a real refusal on a step whose benign code did not match', async () => {
		const { exec, calls } = fakeRunner([{ kind: 'failed', code: 5, output: '[SC] OpenService FAILED 5:\r\n' }]);
		expect((await runAll('win32', DISABLE, exec)).outcome).toBe('permission-denied');
		expect(calls).toEqual(['sc stop w32time']);
	});

	it('reports a missing binary as unsupported, naming it', async () => {
		const { exec } = fakeRunner([{ kind: 'missing' }]);
		expect(await runAll('linux', buildSetNtpEnabledCommands('linux', true), exec)).toEqual({ success: false, outcome: 'unsupported', message: 'timedatectl is not installed' });
	});

	it('reports a wedged command as a transient error, never as an absence', async () => {
		const { exec } = fakeRunner([{ kind: 'timeout' }]);
		expect(await runAll('linux', buildSetNtpEnabledCommands('linux', true), exec)).toEqual({ success: false, outcome: 'error', message: 'timedatectl timed out' });
	});

	it('falls back to the exit code when the command said nothing', async () => {
		const { exec } = fakeRunner([{ kind: 'failed', code: 9009, output: '   \n' }]);
		expect(await runAll('win32', [{ cmd: 'w32tm', args: ['/resync'] }], exec)).toEqual({ success: false, outcome: 'error', message: 'w32tm exited with 9009' });
	});

	it('runs nothing and reports unsupported when the platform yields no command', async () => {
		const { exec, calls } = fakeRunner([]);
		expect(await runAll('win32', buildSetTimezoneCommands('win32', 'Europe/Prague', null), exec)).toEqual({ success: false, outcome: 'unsupported', message: 'no command available for this platform' });
		expect(calls).toEqual([]);
	});
});

/** A host where everything is available and synchronisation is off. */
function statusFixture(overrides: Partial<SystemTimeStatus> = {}): SystemTimeStatus {
	return {
		supported: true,
		nowMs: Date.UTC(2026, 7, 14, 21, 46, 28),
		timezone: 'Europe/Prague',
		utcOffsetMinutes: 120,
		timezoneSource: 'intl',
		ntpEnabled: false,
		ntpSynchronized: null,
		ntpServer: 'ntp1.example.org',
		capabilities: { setClock: true, setTimezone: true, setNtpServer: true, setNtpEnabled: true },
		...overrides,
	};
}

describe('clockWriteRefusal', () => {
	it('lets the write through when nothing else owns the clock', () => {
		expect(clockWriteRefusal(statusFixture())).toBeNull();
	});

	it('refuses while automatic synchronisation is enabled', () => {
		expect(clockWriteRefusal(statusFixture({ ntpEnabled: true }))).toEqual({ success: false, outcome: 'auto-sync-enabled', message: 'automatic time synchronisation is enabled' });
	});

	it('refuses on a host with no facility for writing the clock', () => {
		const refusal = clockWriteRefusal(statusFixture({ capabilities: { setClock: false, setTimezone: false, setNtpServer: false, setNtpEnabled: false } }));
		expect(refusal?.outcome).toBe('unsupported');
		expect(refusal?.success).toBe(false);
	});

	it('refuses a synchronised host even though it has already reached a peer', () => {
		// The refusal is about ownership of the clock, not about the sync having worked.
		expect(clockWriteRefusal(statusFixture({ ntpEnabled: true, ntpSynchronized: true }))?.outcome).toBe('auto-sync-enabled');
		expect(clockWriteRefusal(statusFixture({ ntpEnabled: true, ntpSynchronized: false }))?.outcome).toBe('auto-sync-enabled');
	});

	it('names the missing facility before the sync conflict', () => {
		expect(clockWriteRefusal(statusFixture({ ntpEnabled: true, capabilities: { setClock: false, setTimezone: true, setNtpServer: true, setNtpEnabled: true } }))?.outcome).toBe('unsupported');
	});
});

// These reach the real setters, but every case is rejected by validation or by the
// platform gate before any child process or file write can happen.
describe('setters reject bad input before touching the system', () => {
	it('rejects an out-of-range or non-integer clock', async () => {
		expect(await setSystemClock(24, 0, 0)).toEqual({ success: false, outcome: 'invalid-input', message: 'hours must be between 0 and 23' });
		expect((await setSystemClock(-1, 0, 0)).outcome).toBe('invalid-input');
		expect((await setSystemClock(12, 60, 0)).outcome).toBe('invalid-input');
		expect((await setSystemClock(12, 0, 60)).outcome).toBe('invalid-input');
		expect((await setSystemClock(12.5, 0, 0)).outcome).toBe('invalid-input');
	});

	it('rejects a timezone the host does not list', async () => {
		expect(await setSystemTimezone('Mars/Olympus_Mons')).toEqual({ success: false, outcome: 'invalid-input', message: 'unknown timezone: Mars/Olympus_Mons' });
		expect((await setSystemTimezone('')).outcome).toBe('invalid-input');
		expect((await setSystemTimezone('Europe/Prague; reboot')).outcome).toBe('invalid-input');
		expect((await setSystemTimezone('../../../etc/localtime')).outcome).toBe('invalid-input');
	});

	it('rejects an NTP server carrying whitespace or shell metacharacters', async () => {
		for (const bad of ['ntp.example.org; reboot', 'ntp.example.org two.example.org', 'ntp.example.org && echo x', '$(id)', 'ntp.example.org\nNTP=evil.example.org', '']) {
			const r = await setSystemNtpServer(bad);
			expect(r.success).toBe(false);
			expect(r.outcome).toBe('invalid-input');
		}
	});
});

describe('on a platform with no time backend', () => {
	/** Run `body` with `process.platform` reporting a host we have no backend for. */
	async function onUnsupportedPlatform(body: () => Promise<void>): Promise<void> {
		const original = Object.getOwnPropertyDescriptor(process, 'platform');
		Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true });
		try {
			await body();
		} finally {
			if (original) Object.defineProperty(process, 'platform', original);
		}
	}

	it('reports a status with no capabilities and never claims support', async () => {
		await onUnsupportedPlatform(async () => {
			const status = await getSystemTimeStatus();
			expect(status.supported).toBe(false);
			expect(status.capabilities).toEqual({ setClock: false, setTimezone: false, setNtpServer: false, setNtpEnabled: false });
			expect(status.ntpEnabled).toBe(false);
			expect(status.ntpServer).toBeNull();
			// The clock and the zone come from the process itself, so they stay real.
			expect(status.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
			expect(status.nowMs).toBeGreaterThan(0);
		});
	});

	it('refuses every write, naming the platform', async () => {
		await onUnsupportedPlatform(async () => {
			const results = [await setSystemClock(12, 0, 0), await setSystemTimezone(listSystemTimezones()[0]!), await setSystemNtpServer('ntp.example.org'), await setSystemNtpEnabled(true)];
			for (const r of results) {
				expect(r.success).toBe(false);
				expect(r.outcome).toBe('unsupported');
				expect(r.message).toContain('freebsd');
			}
		});
	});
});

describe('listSystemTimezones', () => {
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

// Live conversion through the ICU library Windows ships. Read-only: it resolves
// identifiers and never touches the system timezone.
describe.skipIf(process.platform !== 'win32')('windows ICU timezone conversion (live)', () => {
	it('converts IANA identifiers to the Windows ones tzutil expects', () => {
		expect(canConvertTimezoneId()).toBe(true);
		expect(ianaToWindowsTimezoneId('Europe/Prague')).toBe('Central Europe Standard Time');
		expect(ianaToWindowsTimezoneId('America/New_York')).toBe('Eastern Standard Time');
		expect(ianaToWindowsTimezoneId('UTC')).toBe('UTC');
	});

	it('returns null for a zone with no Windows equivalent', () => {
		expect(ianaToWindowsTimezoneId('Not/AZone')).toBeNull();
	});

	it('feeds the converted identifier into the tzutil argv', () => {
		const zone = 'America/New_York';
		expect(buildSetTimezoneCommands('win32', zone, ianaToWindowsTimezoneId(zone))).toEqual([{ cmd: 'tzutil', args: ['/s', 'Eastern Standard Time'] }]);
	});
});
