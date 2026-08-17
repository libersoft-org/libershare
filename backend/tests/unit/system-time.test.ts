import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTimesyncdDropIn, buildSetClockCommands, canConfigureTimesyncdServer, COMPETING_NTP_UNITS, parseAnyUnitActive, buildSetNtpEnabledCommands, buildSetNtpServerCommands, buildSetTimezoneCommands, buildTimesyncdDropIn, classifyFailure, clockWriteRefusal, firstLine, getSystemTimeStatus, getTimezoneSource, hostDateParts, isSupportedPlatform, isValidNtpServer, listSystemTimezones, parseRegValue, parseSystemsetupOnOff, parseSystemsetupValue, parseTimedatectlShow, parseTimesyncServer, parseTzutilZone, parseUnitInstalled, type PlatformStatusReader, readNtpUnitsList, rememberWindowsZone, windowsToIanaTimezone, timezoneOffsetMinutes, parseWindowsNtpServer, parseWindowsStartMode, parseWindowsSyncMode, parseWindowsSyncStatus, windowsSyncEnabled, windowsSyncIsOurs, parseYesNo, readWindowsPolicyManaged, runAll, setSystemClock, setSystemNtpEnabled, setSystemNtpServer, setSystemTimezone, syncDirectory, type CommandRunner, type RunOutcome, type SystemCommand, type WindowsModeState, TIMESYNCD_DROPIN_PATH, W32TM_ERROR_RE, validateClockParts, withSystemTimeLock, writeFileAtomically } from '../../src/system-time.ts';
import { canConvertTimezoneId, ianaToWindowsTimezoneId, probeLocalMachineKey, type RegistryKeyProbe, type RegistryKeyState } from '../../src/system-time-windows.ts';
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

/** The same key on a domain member, where the Active Directory hierarchy is the source. */
const REG_QUERY_PARAMS_DOMAIN = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\W32Time\\Parameters\r\n    NtpServer    REG_SZ    dc1.example.org,0x9 dc2.example.org,0x9\r\n    Type    REG_SZ    NT5DS\r\n\r\n';

/** `reg query HKLM\\...\\Services\\W32Time /v Start`, one per start type. */
const REG_QUERY_START_AUTO = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\W32Time\r\n    Start    REG_DWORD    0x2\r\n\r\n';
const REG_QUERY_START_DEMAND = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\W32Time\r\n    Start    REG_DWORD    0x3\r\n\r\n';
const REG_QUERY_START_DISABLED = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\W32Time\r\n    Start    REG_DWORD    0x4\r\n\r\n';

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

describe('parseWindowsStartMode', () => {
	it('reads the start type out of reg query output', () => {
		expect(parseWindowsStartMode(REG_QUERY_START_AUTO)).toBe('automatic');
		expect(parseWindowsStartMode(REG_QUERY_START_DEMAND)).toBe('on-demand');
		expect(parseWindowsStartMode(REG_QUERY_START_DISABLED)).toBe('disabled');
	});

	it('treats boot and system start as starting by itself', () => {
		expect(parseWindowsStartMode('    Start    REG_DWORD    0x0\r\n')).toBe('automatic');
		expect(parseWindowsStartMode('    Start    REG_DWORD    0x1\r\n')).toBe('automatic');
	});

	it('is unknown when the value is absent, unreadable or nonsense', () => {
		expect(parseWindowsStartMode(null)).toBe('unknown');
		expect(parseWindowsStartMode('')).toBe('unknown');
		expect(parseWindowsStartMode('ERROR: The system was unable to find the specified registry key or value.\r\n')).toBe('unknown');
		expect(parseWindowsStartMode('    Start    REG_DWORD    0x9\r\n')).toBe('unknown');
	});
});

describe('parseWindowsSyncMode', () => {
	it('maps every documented Type value', () => {
		expect(parseWindowsSyncMode('NT5DS', false)).toBe('domain-hierarchy');
		expect(parseWindowsSyncMode('NTP', false)).toBe('manual');
		expect(parseWindowsSyncMode('AllSync', false)).toBe('all');
		expect(parseWindowsSyncMode('NoSync', false)).toBe('none');
	});

	it('reads the mode straight out of registry output', () => {
		expect(parseWindowsSyncMode(parseRegValue(REG_QUERY_PARAMS, 'Type'), false)).toBe('manual');
		expect(parseWindowsSyncMode(parseRegValue(REG_QUERY_PARAMS_DOMAIN, 'Type'), false)).toBe('domain-hierarchy');
	});

	/** With a policy present the service's own registry values need not be the effective ones. */
	it('lets group policy override whatever the service key says', () => {
		expect(parseWindowsSyncMode('NTP', true)).toBe('managed');
		expect(parseWindowsSyncMode('NT5DS', true)).toBe('managed');
		expect(parseWindowsSyncMode(null, true)).toBe('managed');
	});

	it('is unknown rather than a guess when the value could not be read', () => {
		expect(parseWindowsSyncMode(null, false)).toBe('unknown');
		expect(parseWindowsSyncMode('', false)).toBe('unknown');
		expect(parseWindowsSyncMode('Something', false)).toBe('unknown');
	});
});

describe('windowsSyncEnabled', () => {
	/**
	 * The case a "is the service running" check gets wrong. Windows Time is trigger
	 * started on a workgroup machine: it syncs, stops, and is still fully configured.
	 * Reading it as "off" would let the UI offer a manual clock set that W32Time then
	 * overwrites at the next trigger.
	 */
	it('is on for a configured service that is not running right now', () => {
		expect(windowsSyncEnabled('manual', 'on-demand')).toBe(true);
		expect(windowsSyncEnabled('domain-hierarchy', 'on-demand')).toBe(true);
	});

	it('is on for every mode that names a time source', () => {
		for (const mode of ['domain-hierarchy', 'manual', 'all', 'managed'] as const) expect(windowsSyncEnabled(mode, 'automatic')).toBe(true);
	});

	it('is definitively off when the service is disabled or has no source', () => {
		expect(windowsSyncEnabled('manual', 'disabled')).toBe(false);
		expect(windowsSyncEnabled('domain-hierarchy', 'disabled')).toBe(false);
		expect(windowsSyncEnabled('none', 'automatic')).toBe(false);
		expect(windowsSyncEnabled('none', 'on-demand')).toBe(false);
	});

	/** An unreadable registry says nothing about the host — never that synchronisation is off. */
	it('is unknown when either half could not be read', () => {
		expect(windowsSyncEnabled('unknown', 'automatic')).toBeNull();
		expect(windowsSyncEnabled('manual', 'unknown')).toBeNull();
		expect(windowsSyncEnabled('unknown', 'unknown')).toBeNull();
	});

	/** A disabled service cannot sync however the source is configured, so that answer stays definite. */
	it('prefers the definite answers over unknown', () => {
		expect(windowsSyncEnabled('unknown', 'disabled')).toBe(false);
		expect(windowsSyncEnabled('none', 'unknown')).toBe(false);
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
		expect(buildTimesyncdDropIn('ntp.example.org')).toBe('[Time]\nNTP=\nNTP=ntp.example.org\n');
	});

	/**
	 * A drop-in is parsed after the shipped configuration and `NTP=` is a list, so
	 * without the empty assignment the distribution's own servers stay in the list and
	 * the chosen one is merely added to them.
	 */
	it('resets the list before assigning, so the server is pinned and not appended', () => {
		const lines = buildTimesyncdDropIn('ntp.example.org').split('\n');
		expect(lines.indexOf('NTP=')).toBeGreaterThan(-1);
		expect(lines.indexOf('NTP=')).toBeLessThan(lines.indexOf('NTP=ntp.example.org'));
	});
});

describe('parseAnyUnitActive', () => {
	/** `systemctl show -p ActiveState --value chronyd.service ... ` on a chrony host. */
	const CHRONY_ACTIVE = 'active\n\ninactive\n\ninactive\n\ninactive\n\ninactive\n';
	const NONE_ACTIVE = 'inactive\n\ninactive\n\ninactive\n\ninactive\n\ninactive\n';

	it('spots the one running daemon among the stopped ones', () => {
		expect(parseAnyUnitActive(CHRONY_ACTIVE)).toBe(true);
		expect(parseAnyUnitActive('inactive\n\nactive\n')).toBe(true);
	});

	it('counts a daemon that is still coming up', () => {
		expect(parseAnyUnitActive('activating\n\ninactive\n')).toBe(true);
		expect(parseAnyUnitActive('reloading\n')).toBe(true);
	});

	it('is false when every unit is stopped, failed or absent', () => {
		expect(parseAnyUnitActive(NONE_ACTIVE)).toBe(false);
		expect(parseAnyUnitActive('failed\n\ninactive\n')).toBe(false);
		expect(parseAnyUnitActive('')).toBe(false);
	});

	/**
	 * This test used to assert the opposite, and the assertion was the bug: timedated counts
	 * everything but `inactive` and `failed` as active, and a daemon that is deactivating has
	 * not let go of the clock yet. `maintenance` is the other state systemd already has that
	 * the old "active/activating/reloading" list missed.
	 */
	it('counts a daemon on its way down, and every other state systemd reports', () => {
		expect(parseAnyUnitActive('deactivating\n')).toBe(true);
		expect(parseAnyUnitActive('maintenance\n')).toBe(true);
		expect(parseAnyUnitActive('inactive\n\ndeactivating\n')).toBe(true);
	});

	/** An unknown state is a state we cannot rule out, so it counts as a daemon in the way. */
	it('fails closed on a state it does not recognise', () => {
		expect(parseAnyUnitActive('refreshing\n')).toBe(true);
		expect(parseAnyUnitActive('inactive (dead)\n')).toBe(true);
	});

	/** Blank separator lines between units are not a state at all. */
	it('ignores the blank lines systemctl puts between units', () => {
		expect(parseAnyUnitActive('inactive\n\n\ninactive\n\n')).toBe(false);
		expect(parseAnyUnitActive('   \n')).toBe(false);
	});
});

describe('canConfigureTimesyncdServer', () => {
	const INSTALLED = 'UNIT FILE                 STATE     PRESET\nsystemd-timesyncd.service disabled  disabled\n\n1 unit files listed.';
	const ABSENT = 'UNIT FILE                 STATE     PRESET\n\n0 unit files listed.';
	const CHRONY_ACTIVE = 'active\n\ninactive\n\ninactive\n\ninactive\n\ninactive\n';
	const NONE_ACTIVE = 'inactive\n\ninactive\n\ninactive\n\ninactive\n\ninactive\n';

	const BOTH_INSTALLED = 'UNIT FILE                 STATE     PRESET\nchronyd.service           disabled  disabled\nsystemd-timesyncd.service disabled  disabled\n\n2 unit files listed.';
	const TIMESYNCD_FIRST = ['systemd-timesyncd.service', 'chronyd.service'];
	const CHRONY_FIRST = ['chronyd.service', 'systemd-timesyncd.service'];

	it('allows the write when timesyncd is the provider timedated would use', () => {
		expect(canConfigureTimesyncdServer(TIMESYNCD_FIRST, INSTALLED, NONE_ACTIVE)).toBe(true);
		expect(canConfigureTimesyncdServer(TIMESYNCD_FIRST, BOTH_INSTALLED, NONE_ACTIVE)).toBe(true);
	});

	/**
	 * The case that used to slip through. chrony is INSTALLED but stopped, so no active
	 * unit gives it away — yet its `50-chronyd.list` sorts ahead of timesyncd's, so
	 * `timedatectl set-ntp true` starts chrony and the drop-in we just wrote is read by
	 * nobody.
	 */
	it('refuses when an installed but stopped daemon comes first in the provider order', () => {
		expect(canConfigureTimesyncdServer(CHRONY_FIRST, BOTH_INSTALLED, NONE_ACTIVE)).toBe(false);
	});

	/** A provider ordered ahead of timesyncd but not installed is skipped, as timedated skips it. */
	it('looks past a leading provider the host does not have', () => {
		expect(canConfigureTimesyncdServer(CHRONY_FIRST, INSTALLED, NONE_ACTIVE)).toBe(true);
	});

	/**
	 * The case the capability is really for: chrony holds the clock, so a timesyncd
	 * drop-in changes nothing and restarting timesyncd would only add a second daemon.
	 */
	it('refuses while another NTP daemon is the active backend', () => {
		expect(canConfigureTimesyncdServer(TIMESYNCD_FIRST, INSTALLED, CHRONY_ACTIVE)).toBe(false);
		expect(canConfigureTimesyncdServer([], INSTALLED, CHRONY_ACTIVE)).toBe(false);
	});

	it('refuses on a host with no timesyncd unit at all', () => {
		expect(canConfigureTimesyncdServer(TIMESYNCD_FIRST, ABSENT, NONE_ACTIVE)).toBe(false);
		expect(canConfigureTimesyncdServer(TIMESYNCD_FIRST, null, NONE_ACTIVE)).toBe(false);
	});

	/** No provider ordering on the host at all: `set-ntp` has nothing to hand the clock to, so the installed check stands alone. */
	it('falls back to the installed check when the host ships no provider ordering', () => {
		expect(canConfigureTimesyncdServer([], INSTALLED, NONE_ACTIVE)).toBe(true);
		expect(canConfigureTimesyncdServer([], ABSENT, NONE_ACTIVE)).toBe(false);
	});

	/**
	 * The unknown states, which are neither "no competitor" nor "no ordering". A read that
	 * failed used to be indistinguishable from one that came back empty, and empty is the
	 * permissive answer: the drop-in lands and is reported as saved while chrony — running,
	 * or ordered ahead of timesyncd in a list we could not read — keeps the clock.
	 */
	it('refuses when the competing-daemon state could not be read', () => {
		expect(canConfigureTimesyncdServer(TIMESYNCD_FIRST, INSTALLED, null)).toBe(false);
		expect(canConfigureTimesyncdServer([], INSTALLED, null)).toBe(false);
	});

	it('refuses when the provider ordering could not be read', () => {
		expect(canConfigureTimesyncdServer(null, INSTALLED, NONE_ACTIVE)).toBe(false);
	});

	it('names every implementation timedated can hand the clock to', () => {
		expect(COMPETING_NTP_UNITS).toContain('chronyd.service');
		expect(COMPETING_NTP_UNITS).toContain('ntpd.service');
		expect(COMPETING_NTP_UNITS.every(u => u.endsWith('.service'))).toBe(true);
	});
});

describe('readNtpUnitsList', () => {
	let root = '';

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'lish-ntpunits-'));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	/** Write `files` into `<root>/<dir>` and return the path, so directory precedence can be exercised. */
	async function dir(name: string, files: Record<string, string>): Promise<string> {
		const path = join(root, name);
		await mkdir(path, { recursive: true });
		for (const [file, content] of Object.entries(files)) await writeFile(join(path, file), content, 'utf8');
		return path;
	}

	/**
	 * The ordering that decides which daemon `set-ntp` starts. chrony's list file carries
	 * a lower numeric prefix than timesyncd's on every distribution that ships both.
	 */
	it('orders the providers by list file name, not by directory', async () => {
		const lib = await dir('lib', { '80-systemd-timesync.list': 'systemd-timesyncd.service\n', '50-chronyd.list': 'chronyd.service\n' });
		expect(await readNtpUnitsList([lib], {})).toEqual(['chronyd.service', 'systemd-timesyncd.service']);
	});

	it('lets an earlier directory shadow the same file name in a later one', async () => {
		const etc = await dir('etc', { '50-chronyd.list': 'replacement.service\n' });
		const lib = await dir('lib', { '50-chronyd.list': 'chronyd.service\n', '80-systemd-timesync.list': 'systemd-timesyncd.service\n' });
		expect(await readNtpUnitsList([etc, lib], {})).toEqual(['replacement.service', 'systemd-timesyncd.service']);
	});

	it('skips comments, blank lines and repeats, and ignores files that are not lists', async () => {
		const lib = await dir('lib', { '50-a.list': '# a comment\n\nchronyd.service\nchronyd.service\n', README: 'ntpd.service\n' });
		expect(await readNtpUnitsList([lib], {})).toEqual(['chronyd.service']);
	});

	it('takes the environment override in place of the directories', async () => {
		const lib = await dir('lib', { '50-chronyd.list': 'chronyd.service\n' });
		expect(await readNtpUnitsList([lib], { SYSTEMD_TIMEDATED_NTP_SERVICES: 'ntpsec.service:systemd-timesyncd.service' })).toEqual(['ntpsec.service', 'systemd-timesyncd.service']);
	});

	it('reports no ordering at all on a host without the directories', async () => {
		expect(await readNtpUnitsList([join(root, 'nowhere')], {})).toEqual([]);
	});

	/**
	 * A directory that is not there is the ordinary case and stays an empty ordering. A
	 * directory that IS there and could not be listed is a different answer: the entry that
	 * would have put another daemon ahead of timesyncd may be exactly the one not read, so
	 * the ordering is reported as unknown rather than as absent.
	 */
	it('reports an unknown ordering when a directory cannot be listed', async () => {
		const lib = await dir('lib', { '80-systemd-timesync.list': 'systemd-timesyncd.service\n' });
		const notADirectory = join(root, 'blocked');
		await writeFile(notADirectory, 'in the way', 'utf8');
		expect(await readNtpUnitsList([notADirectory, lib], {})).toBeNull();
	});

	it('reports an unknown ordering when a list file cannot be read', async () => {
		const lib = await dir('lib', {});
		await mkdir(join(lib, '50-chronyd.list'));
		expect(await readNtpUnitsList([lib], {})).toBeNull();
	});
});

describe('TIMESYNCD_DROPIN_PATH', () => {
	/**
	 * Drop-ins are applied in lexicographic order and a later file re-overrides the same
	 * key, so a prefix below the distribution's own `50-*.conf` loses silently while the
	 * API still reports the server as configured.
	 */
	it('sorts after a distribution drop-in, in the range systemd reserves for /etc overrides', () => {
		const name = TIMESYNCD_DROPIN_PATH.split('/').pop() ?? '';
		const prefix = Number(/^(\d+)-/.exec(name)?.[1]);
		expect(prefix).toBeGreaterThanOrEqual(60);
		expect(prefix).toBeLessThanOrEqual(90);
		for (const other of ['10-distro.conf', '50-distro.conf']) expect(name > other).toBe(true);
	});

	it('lives in the timesyncd drop-in directory and is ours alone', () => {
		expect(TIMESYNCD_DROPIN_PATH.startsWith('/etc/systemd/timesyncd.conf.d/')).toBe(true);
		expect(TIMESYNCD_DROPIN_PATH).toContain('libershare');
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

	it('configures the peer and resyncs on windows while synchronisation is on', () => {
		expect(buildSetNtpServerCommands('win32', 'ntp.example.org', true)).toEqual([
			{ cmd: 'w32tm', args: ['/config', '/manualpeerlist:ntp.example.org,0x8', '/syncfromflags:manual', '/update'], failOnOutput: W32TM_ERROR_RE },
			{ cmd: 'w32tm', args: ['/resync'], failOnOutput: W32TM_ERROR_RE },
		]);
	});

	/**
	 * A resync is a request to the Windows Time service, so with the service stopped it
	 * can only fail — and the UI arrives here exactly that way, switching synchronisation
	 * off before writing a server. Configuring the peer list is the whole change then.
	 *
	 * `/update` goes with it: it notifies the RUNNING service that the configuration
	 * changed, so against a stopped one it is the same failed request — which is how a
	 * peer list that had in fact been written came back to the user as an error. The
	 * registry write happens without it, and the service reads it when it next starts.
	 */
	it('skips the resync and the update notification on windows while synchronisation is off', () => {
		expect(buildSetNtpServerCommands('win32', 'ntp.example.org', false)).toEqual([{ cmd: 'w32tm', args: ['/config', '/manualpeerlist:ntp.example.org,0x8', '/syncfromflags:manual'], failOnOutput: W32TM_ERROR_RE }]);
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

	/**
	 * The one mode where "switch synchronisation on" has to invent a time source: the
	 * host has none, so the /config step is what clears Type=NoSync. Without it the
	 * status read still reports synchronisation as off and the toggle looks like it did
	 * not stick.
	 */
	it('gives a host with no time source one, on windows', () => {
		expect(buildSetNtpEnabledCommands('win32', true, 'none')).toEqual([
			{ cmd: 'sc', args: ['config', 'w32time', 'start=', 'auto'] },
			{ cmd: 'sc', args: ['start', 'w32time'], benignCodes: [1056] },
			{ cmd: 'w32tm', args: ['/config', '/syncfromflags:manual', '/update'], failOnOutput: W32TM_ERROR_RE },
			{ cmd: 'w32tm', args: ['/resync'], failOnOutput: W32TM_ERROR_RE },
		]);
	});

	/**
	 * The destructive case. On a domain member Type is NT5DS and the machine takes its
	 * time from the Active Directory hierarchy; rewriting syncfromflags to manual
	 * detaches it from the forest's time and eventually breaks Kerberos. Switching
	 * synchronisation on must start the service and nothing else.
	 */
	it('never rewrites a time source it did not create, on windows', () => {
		for (const mode of ['domain-hierarchy', 'manual', 'all', 'managed', 'unknown'] as const) {
			const commands = buildSetNtpEnabledCommands('win32', true, mode);
			expect(commands.map(c => [c.cmd, ...c.args].join(' '))).toEqual(['sc config w32time start= auto', 'sc start w32time', 'w32tm /resync']);
			expect(commands.some(c => c.args.some(a => a.startsWith('/syncfromflags')))).toBe(false);
		}
	});

	/** A caller that could not determine the mode must get the harmless behaviour. */
	it('rewrites nothing when the mode was not given at all', () => {
		expect(buildSetNtpEnabledCommands('win32', true).some(c => c.args.includes('/syncfromflags:manual'))).toBe(false);
	});

	it('stops and disables the service on windows, whatever the source was', () => {
		for (const mode of ['none', 'manual', 'all'] as const) {
			expect(buildSetNtpEnabledCommands('win32', false, mode)).toEqual([
				{ cmd: 'sc', args: ['stop', 'w32time'], benignCodes: [1062] },
				{ cmd: 'sc', args: ['config', 'w32time', 'start=', 'disabled'] },
			]);
		}
	});

	it('stops the service before disabling it, so the switch takes effect at once', () => {
		expect(buildSetNtpEnabledCommands('win32', false).map(c => c.args[0])).toEqual(['stop', 'config']);
	});

	it('marks only the service run-state steps as tolerable, never the ones carrying the change', () => {
		// A host whose service is already in the requested run state must still get its
		// sync type and start mode written, so those steps may not sit behind an abort.
		const tolerated = (enabled: boolean): string[] =>
			buildSetNtpEnabledCommands('win32', enabled, 'none')
				.filter(c => c.benignCodes !== undefined)
				.map(c => [c.cmd, ...c.args].join(' '));
		expect(tolerated(true)).toEqual(['sc start w32time']);
		expect(tolerated(false)).toEqual(['sc stop w32time']);
	});
});

describe('setSystemNtpEnabled', () => {
	/** Run `body` with `process.platform` reporting the given host. */
	async function onPlatform(platform: string, body: () => Promise<void>): Promise<void> {
		const original = Object.getOwnPropertyDescriptor(process, 'platform');
		Object.defineProperty(process, 'platform', { value: platform, configurable: true });
		try {
			await body();
		} finally {
			if (original) Object.defineProperty(process, 'platform', original);
		}
	}

	const capable = async (): Promise<SystemTimeStatus> => statusFixture();

	/** A Windows host whose time source this application configured itself. */
	const ourWindowsHost = async (): Promise<WindowsModeState> => ({ mode: 'manual', start: 'automatic' });

	it('reports success once every step has succeeded', async () => {
		await onPlatform('linux', async () => {
			const { exec, calls } = fakeRunner([]);
			expect(await setSystemNtpEnabled(true, capable, exec)).toEqual({ success: true, outcome: 'ok', message: null });
			expect(calls).toEqual(['timedatectl set-ntp true']);
		});
	});

	/**
	 * The masking this used to do. A re-read afterwards saw `ntpEnabled` matching the
	 * request and rewrote the whole thing to `ok`, so a step that genuinely refused —
	 * here the one that carries the change — was reported to the user as saved.
	 */
	it('does not turn a refused step into a success because the state happens to match', async () => {
		await onPlatform('linux', async () => {
			const { exec } = fakeRunner([{ kind: 'failed', code: 1, output: 'Failed to set ntp: something went wrong\n' }]);
			// The host reads back exactly as requested, which is what used to erase the error.
			const readsAsEnabled = async (): Promise<SystemTimeStatus> => statusFixture({ ntpEnabled: true });
			const r = await setSystemNtpEnabled(true, readsAsEnabled, exec);
			expect(r.success).toBe(false);
			expect(r.outcome).toBe('error');
			expect(r.message).toBe('Failed to set ntp: something went wrong');
		});
	});

	it('keeps a failed windows resync visible even though the service did start', async () => {
		await onPlatform('win32', async () => {
			// Keyed on the command rather than on a queue: the exact step list depends on
			// the mode this host's registry reports, and only the resync matters here.
			const calls: string[] = [];
			const exec: CommandRunner = async (cmd, args) => {
				const line = [cmd, ...args].join(' ');
				calls.push(line);
				return line === 'w32tm /resync' ? { kind: 'ok', output: 'The computer did not resync because no time data was available. (0x800705B4)\r\n' } : { kind: 'ok', output: '' };
			};
			const r = await setSystemNtpEnabled(true, capable, exec, ourWindowsHost);
			expect(r.success).toBe(false);
			expect(r.outcome).toBe('error');
			expect(calls).toContain('w32tm /resync');
			expect(calls[0]).toBe('sc config w32time start= auto');
		});
	});

	/** Still tolerated, but at the source: `sc` exits 1056 when the service is already up. */
	it('still carries on past a service that was already in the requested state', async () => {
		await onPlatform('win32', async () => {
			const { exec } = fakeRunner([
				{ kind: 'ok', output: '' },
				{ kind: 'failed', code: 1056, output: '[SC] StartService FAILED 1056:\r\n' },
			]);
			expect((await setSystemNtpEnabled(true, capable, exec, ourWindowsHost)).success).toBe(true);
		});
	});

	it('refuses without running anything when the host does not allow the change', async () => {
		await onPlatform('win32', async () => {
			const { exec, calls } = fakeRunner([]);
			const managed = async (): Promise<SystemTimeStatus> => statusFixture({ capabilities: { setClock: true, setTimezone: true, setNtpServer: false, setNtpEnabled: false } });
			expect((await setSystemNtpEnabled(true, managed, exec)).outcome).toBe('unsupported');
			expect(calls).toEqual([]);
		});
	});

	/**
	 * The capability came from a status read before the write started. A host joined to a
	 * domain in between must not have W32Time stopped and disabled on the strength of it,
	 * so ownership is decided again on a read taken immediately before the commands run.
	 */
	it('refuses when the host stopped being ours between the status read and the write', async () => {
		await onPlatform('win32', async () => {
			const { exec, calls } = fakeRunner([]);
			const joinedADomain = async (): Promise<WindowsModeState> => ({ mode: 'domain-hierarchy', start: 'automatic' });
			expect((await setSystemNtpEnabled(false, capable, exec, joinedADomain)).outcome).toBe('unsupported');
			expect(calls).toEqual([]);
		});
	});

	it('refuses when a group policy arrived between the status read and the write', async () => {
		await onPlatform('win32', async () => {
			const { exec, calls } = fakeRunner([]);
			const policyApplied = async (): Promise<WindowsModeState> => ({ mode: 'managed', start: 'automatic' });
			expect((await setSystemNtpEnabled(true, capable, exec, policyApplied)).outcome).toBe('unsupported');
			expect(calls).toEqual([]);
		});
	});
});

describe('setSystemNtpServer', () => {
	/** Run `body` with `process.platform` reporting the given host. */
	async function onPlatform(platform: string, body: () => Promise<void>): Promise<void> {
		const original = Object.getOwnPropertyDescriptor(process, 'platform');
		Object.defineProperty(process, 'platform', { value: platform, configurable: true });
		try {
			await body();
		} finally {
			if (original) Object.defineProperty(process, 'platform', original);
		}
	}

	const capable = async (): Promise<SystemTimeStatus> => statusFixture();

	it('writes the peer list on a host whose time source is ours', async () => {
		await onPlatform('win32', async () => {
			const { exec, calls } = fakeRunner([]);
			const ours = async (): Promise<WindowsModeState> => ({ mode: 'manual', start: 'disabled' });
			expect((await setSystemNtpServer('ntp.example.org', capable, ours, exec)).success).toBe(true);
			// Start mode `disabled` means the service is not running, so nothing is asked of it.
			expect(calls).toEqual(['w32tm /config /manualpeerlist:ntp.example.org,0x8 /syncfromflags:manual']);
		});
	});

	/**
	 * This check did not exist at all: the write went off the capability in the status and
	 * never looked at the mode, so a domain member could have its peer list and sync flags
	 * overwritten — which is what detaches it from the forest's time.
	 */
	it('refuses a host whose time source stopped being ours before the write', async () => {
		await onPlatform('win32', async () => {
			const { exec, calls } = fakeRunner([]);
			const joinedADomain = async (): Promise<WindowsModeState> => ({ mode: 'domain-hierarchy', start: 'automatic' });
			expect((await setSystemNtpServer('ntp.example.org', capable, joinedADomain, exec)).outcome).toBe('unsupported');
			expect(calls).toEqual([]);
		});
	});

	it('refuses a host that became policy-managed before the write', async () => {
		await onPlatform('win32', async () => {
			const { exec, calls } = fakeRunner([]);
			const policyApplied = async (): Promise<WindowsModeState> => ({ mode: 'managed', start: 'automatic' });
			expect((await setSystemNtpServer('ntp.example.org', capable, policyApplied, exec)).outcome).toBe('unsupported');
			expect(calls).toEqual([]);
		});
	});
});

describe('readWindowsPolicyManaged', () => {
	/** The root of the branch, which is the one question that cannot miss a subkey. */
	const POLICY_ROOT = 'SOFTWARE\\Policies\\Microsoft\\W32Time';

	/** Answer the probe from a map; anything not listed is a key that is genuinely not there. */
	function registry(states: Record<string, RegistryKeyState>): { probe: RegistryKeyProbe; keys: string[] } {
		const keys: string[] = [];
		const probe: RegistryKeyProbe = subKey => {
			keys.push(subKey);
			return states[subKey] ?? 'absent';
		};
		return { probe, keys };
	}

	it('reports an unmanaged host when the policy branch does not exist', () => {
		const { probe, keys } = registry({});
		expect(readWindowsPolicyManaged(probe)).toBe(false);
		expect(keys).toEqual([POLICY_ROOT]);
	});

	/**
	 * Every subkey a policy can land in reports through its parent, so the root is asked
	 * rather than a hand-picked list — enumerating a chosen few answered "unmanaged" for
	 * every branch not on it, `TimeProviders\NtpServer` included.
	 */
	it('reports a managed host when the policy branch is there', () => {
		const { probe } = registry({ [POLICY_ROOT]: 'present' });
		expect(readWindowsPolicyManaged(probe)).toBe(true);
	});

	/**
	 * The case the old `reg query` exit code could not see, and the reason this went to the
	 * Win32 call: an administrator's policy branch carrying its own ACL. `reg` exits 1 for
	 * it exactly as it does for a key that is not there — and the parent `HKLM\SOFTWARE\
	 * Policies` stays readable, so the control key confirmed an "absence" that was really a
	 * denial and the host was declared ours to stop, disable and reconfigure.
	 */
	it('treats a denied policy key as managed even though its parent reads', () => {
		const { probe } = registry({ [POLICY_ROOT]: 'unreadable', 'SOFTWARE\\Policies': 'present' });
		expect(readWindowsPolicyManaged(probe)).toBe(true);
	});

	/** Fail closed on anything short of a proven absence — a missing advapi32 included. */
	it('treats an unreadable branch as managed', () => {
		const { probe } = registry({ [POLICY_ROOT]: 'unreadable' });
		expect(readWindowsPolicyManaged(probe)).toBe(true);
	});
});

describe('probeLocalMachineKey', () => {
	const windows = process.platform === 'win32';

	/**
	 * The real registry, because the whole fix rests on `RegOpenKeyExW` returning distinct
	 * codes where `reg.exe` returns 1 for everything. A mock would only re-assert the
	 * mapping this module already spells out.
	 *
	 * `SYSTEM\CurrentControlSet\Services\W32Time` is on every Windows install, and `SECURITY`
	 * is the standard key that exists and is denied to everything but SYSTEM — which is the
	 * pair the old exit-code route could not tell apart.
	 */
	it.skipIf(!windows)('tells present, absent and denied keys apart', () => {
		expect(probeLocalMachineKey('SYSTEM\\CurrentControlSet\\Services\\W32Time')).toBe('present');
		expect(probeLocalMachineKey('SOFTWARE\\LiberShareNoSuchKeyExists')).toBe('absent');
		// Not `unreadable` outright: run as SYSTEM this key does open. The load-bearing claim
		// is the one the exit code got wrong — a key that EXISTS is never reported absent.
		expect(probeLocalMachineKey('SECURITY')).not.toBe('absent');
	});

	/** Never throws, whatever it is handed and whatever platform it runs on. */
	it('answers unreadable rather than throwing off Windows or on a bad name', () => {
		expect(['present', 'absent', 'unreadable']).toContain(probeLocalMachineKey(''));
		expect(['present', 'absent', 'unreadable']).toContain(probeLocalMachineKey('a'.repeat(500)));
	});
});

describe('windowsSyncIsOurs', () => {
	it('allows a change only where this application configured the source itself', () => {
		expect(windowsSyncIsOurs('manual')).toBe(true);
		expect(windowsSyncIsOurs('none')).toBe(true);
	});

	/**
	 * A domain member, a policy-managed host and an unidentifiable one are all somebody
	 * else's configuration. The capability being false is what keeps the UI from
	 * offering a change that would detach the machine from its domain's time.
	 */
	it('refuses a domain, policy-managed or unidentified host', () => {
		expect(windowsSyncIsOurs('domain-hierarchy')).toBe(false);
		expect(windowsSyncIsOurs('managed')).toBe(false);
		expect(windowsSyncIsOurs('unknown')).toBe(false);
	});

	/**
	 * AllSync is every available source at once, the AD hierarchy included. It used to be
	 * treated as ours, which let the toggle stop and disable W32Time on a domain member
	 * configured that way.
	 */
	it('refuses a host synchronising from every available source', () => {
		expect(windowsSyncIsOurs('all')).toBe(false);
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
		expect(await runAll('win32', DISABLE, exec)).toEqual({ success: false, outcome: 'permission-denied', message: '[SC] OpenService FAILED 5:', changed: false, stateMayHaveChanged: true, steps: [{ command: 'sc stop w32time', ok: false }] });
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
		expect(await runAll('win32', buildSetNtpEnabledCommands('win32', true, 'none'), exec)).toEqual({ success: true, outcome: 'ok', message: null });
		expect(calls).toEqual(['sc config w32time start= auto', 'sc start w32time', 'w32tm /config /syncfromflags:manual /update', 'w32tm /resync']);
	});

	/**
	 * The failure that used to look like "nothing happened": the service is already down
	 * and its start mode is already changed by the time the next step refuses. A caller
	 * that shows the old state after this is showing something the host no longer is.
	 */
	it('reports what a sequence already applied before it stopped', async () => {
		const { exec } = fakeRunner([
			{ kind: 'ok', output: '' },
			{ kind: 'failed', code: 5, output: '[SC] OpenService FAILED 5:\r\n' },
		]);
		const r = await runAll('win32', DISABLE, exec);
		expect(r.success).toBe(false);
		expect(r.changed).toBe(true);
		expect(r.stateMayHaveChanged).toBe(true);
		expect(r.steps).toEqual([
			{ command: 'sc stop w32time', ok: true },
			{ command: 'sc config w32time start= disabled', ok: false },
		]);
	});

	/** A step tolerated by its benign code still counts as run, so it is reported as such. */
	it('counts a tolerated step among the ones that ran', async () => {
		const { exec } = fakeRunner([
			{ kind: 'failed', code: 1062, output: '[SC] ControlService FAILED 1062:\r\n' },
			{ kind: 'failed', code: 5, output: '[SC] OpenService FAILED 5:\r\n' },
		]);
		const r = await runAll('win32', DISABLE, exec);
		expect(r.changed).toBe(true);
		expect(r.steps?.map(step => step.ok)).toEqual([true, false]);
	});

	it('still reports a real refusal on a step whose benign code did not match', async () => {
		const { exec, calls } = fakeRunner([{ kind: 'failed', code: 5, output: '[SC] OpenService FAILED 5:\r\n' }]);
		expect((await runAll('win32', DISABLE, exec)).outcome).toBe('permission-denied');
		expect(calls).toEqual(['sc stop w32time']);
	});

	it('reports a missing binary as unsupported, naming it', async () => {
		const { exec } = fakeRunner([{ kind: 'missing' }]);
		// A binary that does not exist never ran, so nothing on the host can have moved.
		expect(await runAll('linux', buildSetNtpEnabledCommands('linux', true), exec)).toEqual({ success: false, outcome: 'unsupported', message: 'timedatectl is not installed', changed: false, stateMayHaveChanged: false, steps: [{ command: 'timedatectl set-ntp true', ok: false }] });
	});

	it('reports a wedged command as a transient error, never as an absence', async () => {
		const { exec } = fakeRunner([{ kind: 'timeout' }]);
		// A killed command DID start, so it may have applied part of its change.
		expect(await runAll('linux', buildSetNtpEnabledCommands('linux', true), exec)).toEqual({ success: false, outcome: 'error', message: 'timedatectl timed out', changed: false, stateMayHaveChanged: true, steps: [{ command: 'timedatectl set-ntp true', ok: false }] });
	});

	it('falls back to the exit code when the command said nothing', async () => {
		const { exec } = fakeRunner([{ kind: 'failed', code: 9009, output: '   \n' }]);
		expect(await runAll('win32', [{ cmd: 'w32tm', args: ['/resync'] }], exec)).toEqual({ success: false, outcome: 'error', message: 'w32tm exited with 9009', changed: false, stateMayHaveChanged: true, steps: [{ command: 'w32tm /resync', ok: false }] });
	});

	/**
	 * The case an exit-code check alone gets wrong. `w32tm` prints the HRESULT of a
	 * refusal and returns zero anyway, so without reading the output a refused `/resync`
	 * is reported to the user as a saved setting.
	 */
	it('fails a w32tm step that printed an HRESULT and still exited 0', async () => {
		const { exec, calls } = fakeRunner([
			{ kind: 'ok', output: '' },
			{ kind: 'ok', output: 'The computer did not resync because no time data was available.\r\n0x80070005\r\n' },
		]);
		const r = await runAll('win32', buildSetNtpServerCommands('win32', 'ntp.example.org', true), exec);
		expect(r.success).toBe(false);
		expect(r.outcome).toBe('permission-denied');
		expect(r.message).toBe('The computer did not resync because no time data was available.');
		expect(calls).toHaveLength(2);
	});

	it('reads the HRESULT rather than the localized sentence around it', async () => {
		const { exec } = fakeRunner([{ kind: 'ok', output: 'Pocitac se nesynchronizoval, protoze nebyla k dispozici zadna data. (0x800705B4)\r\n' }]);
		const r = await runAll('win32', [{ cmd: 'w32tm', args: ['/resync'], failOnOutput: W32TM_ERROR_RE }], exec);
		expect(r.success).toBe(false);
		expect(r.outcome).toBe('error');
	});

	it('does not mistake the identifiers a healthy w32tm prints for a failure', async () => {
		// ReferenceId and the poll interval carry hex and digits but no 0x8 HRESULT.
		const { exec } = fakeRunner([{ kind: 'ok', output: W32TM_STATUS }]);
		expect((await runAll('win32', [{ cmd: 'w32tm', args: ['/resync'], failOnOutput: W32TM_ERROR_RE }], exec)).success).toBe(true);
	});

	it('leaves a command without an output check judged on its exit code alone', async () => {
		const { exec } = fakeRunner([{ kind: 'ok', output: 'mentions 0x80070005 but is not checked' }]);
		expect((await runAll('win32', [{ cmd: 'sc', args: ['query', 'w32time'] }], exec)).success).toBe(true);
	});

	it('runs nothing and reports unsupported when the platform yields no command', async () => {
		const { exec, calls } = fakeRunner([]);
		expect(await runAll('win32', buildSetTimezoneCommands('win32', 'Europe/Prague', null), exec)).toEqual({ success: false, outcome: 'unsupported', message: 'no command available for this platform' });
		expect(calls).toEqual([]);
	});
});

describe('writeFileAtomically', () => {
	let dir = '';

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'lish-time-'));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('creates the file and leaves no temporary behind', async () => {
		const path = join(dir, '90-libershare.conf');
		await writeFileAtomically(path, 'first\n');
		expect(await readFile(path, 'utf8')).toBe('first\n');
		expect(await readdir(dir)).toEqual(['90-libershare.conf']);
	});

	/**
	 * A platform that has no directory flush must not lose the write over it. This is a real
	 * flush of a real directory, so on Windows it exercises the refusal itself (the handle
	 * opens and `fsync` on it returns EPERM) and elsewhere the flush that works.
	 */
	it('publishes the file whether or not the directory can be flushed', async () => {
		const path = join(dir, '90-libershare.conf');
		await writeFileAtomically(path, 'durable\n');
		expect(await readFile(path, 'utf8')).toBe('durable\n');
		expect(await readdir(dir)).toEqual(['90-libershare.conf']);
	});

	/**
	 * A flush that was ATTEMPTED and failed is not the same as one the platform does not
	 * have. EIO and ENOSPC mean the metadata is not reliably stored — swallowing them
	 * reported a durability the filesystem had just declined — while EPERM/EISDIR/EINVAL are
	 * the "no such operation here" codes and stay silent.
	 */
	it('propagates a genuine directory flush error and ignores the unsupported ones', async () => {
		const fail = async (code: string): Promise<unknown> => syncDirectory(join(dir, `probe-${code}`)).catch((err: Error) => err);
		// A directory that is not there: a real error from the real implementation.
		expect(await fail('ENOENT')).toBeInstanceOf(Error);
		// And the ordinary path stays quiet on every platform, refusal included.
		expect(await syncDirectory(dir)).toBeUndefined();
	});

	/**
	 * The rename already happened, so the content is live under its final name. Removing the
	 * temporary file would delete exactly that, and reporting a clean failure would claim
	 * nothing happened — the flag is what lets the caller say which of the two it has.
	 */
	it('marks a post-rename flush failure as published and keeps the file', async () => {
		const path = join(dir, '90-libershare.conf');
		const eio = async (): Promise<void> => Promise.reject(Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }));
		const err = await writeFileAtomically(path, 'new\n', p => readFile(p, 'utf8'), eio).catch((e: { published?: boolean; code?: string }) => e);
		expect(err).toMatchObject({ published: true, code: 'EIO' });
		// Published means published: the file is there and no staging file was left behind.
		expect(await readFile(path, 'utf8')).toBe('new\n');
		expect(await readdir(dir)).toEqual(['90-libershare.conf']);
	});

	/** Before the rename nothing is published, so the temp file goes and the error is bare. */
	it('cleans up and does not mark a pre-rename failure as published', async () => {
		const path = join(dir, 'made-here', '90-libershare.conf');
		const eio = async (): Promise<void> => Promise.reject(Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }));
		// The parent flush runs before anything is written, because the directory was created.
		const err = await writeFileAtomically(path, 'new\n', p => readFile(p, 'utf8'), eio).catch((e: { published?: boolean }) => e);
		expect(err).toMatchObject({ code: 'EIO' });
		expect(err).not.toMatchObject({ published: true });
		expect(await readdir(join(dir, 'made-here'))).toEqual([]);
	});

	it('creates a missing parent directory', async () => {
		const path = join(dir, 'timesyncd.conf.d', '90-libershare.conf');
		await writeFileAtomically(path, 'x\n');
		expect(await readFile(path, 'utf8')).toBe('x\n');
	});

	/**
	 * Creating the directory is itself a change to ITS parent. Flushing only the new
	 * directory commits what is inside it, not the entry that names it — a crash then comes
	 * back to no `timesyncd.conf.d` at all and a drop-in nothing can read.
	 */
	it('flushes the parent of a directory it had to create', async () => {
		const path = join(dir, 'a', 'b', '90-libershare.conf');
		const flushed: string[] = [];
		await writeFileAtomically(
			path,
			'x\n',
			p => readFile(p, 'utf8'),
			async d => void flushed.push(d)
		);
		// `mkdir` answers with an extended-length path on Windows (`\\?\C:\...`), which opens
		// just the same — the prefix comes off so the assertion is about the directory.
		// The first directory created is `a`, so its parent is the flush the rename would miss.
		expect(flushed.map(d => d.replace(/^\\\\\?\\/, ''))).toEqual([dir, join(dir, 'a', 'b')]);
	});

	/**
	 * Removing the name is a directory change like the rename was, and buffered the same way.
	 * Without the flush a crash can bring the entry back and with it the drop-in this
	 * rollback exists to withdraw.
	 */
	it('flushes the directory after the rollback removes a file it created', async () => {
		const path = join(dir, '90-libershare.conf');
		const flushed: string[] = [];
		const rollback = await writeFileAtomically(
			path,
			'new\n',
			p => readFile(p, 'utf8'),
			async d => void flushed.push(d)
		);
		expect(await rollback()).toBe(true);
		expect(await readdir(dir)).toEqual([]);
		// Once for the rename, once for the unlink that took the name away again.
		expect(flushed).toEqual([dir, dir]);
	});

	it('rolls an overwrite back to the previous content', async () => {
		const path = join(dir, '90-libershare.conf');
		await writeFile(path, 'original\n', 'utf8');
		const rollback = await writeFileAtomically(path, 'replacement\n');
		expect(await readFile(path, 'utf8')).toBe('replacement\n');
		await rollback();
		expect(await readFile(path, 'utf8')).toBe('original\n');
		expect(await readdir(dir)).toEqual(['90-libershare.conf']);
	});

	/**
	 * A staging name shared by concurrent calls is not a staging name: the second write
	 * truncates the first one's file, the first renames the second's content into place
	 * and the second then fails with ENOENT on a name that is already gone.
	 */
	it('stages concurrent writes under separate temporary names', async () => {
		const path = join(dir, '90-libershare.conf');
		await Promise.all([writeFileAtomically(path, 'first\n'), writeFileAtomically(path, 'second\n')]);
		expect(['first\n', 'second\n']).toContain(await readFile(path, 'utf8'));
		expect(await readdir(dir)).toEqual(['90-libershare.conf']);
	});

	/**
	 * A rollback that could not put the old file back used to look exactly like one that
	 * did. The caller then reports "nothing happened" while the new configuration is still
	 * on disk, waiting to be adopted at the next boot.
	 */
	it('says so when it could not restore the previous content', async () => {
		const path = join(dir, '90-libershare.conf');
		await writeFile(path, 'original\n', 'utf8');
		const rollback = await writeFileAtomically(path, 'replacement\n');
		// Replace the whole directory with a file: nothing can be written under it again.
		await rm(dir, { recursive: true, force: true });
		await writeFile(dir, 'in the way', 'utf8');
		expect(await rollback()).toBe(false);
	});

	it('treats a file that is already gone as restored', async () => {
		const path = join(dir, '90-libershare.conf');
		const rollback = await writeFileAtomically(path, 'new\n');
		await rm(path, { force: true });
		expect(await rollback()).toBe(true);
	});

	it('rolls a creation back by removing the file it created', async () => {
		const path = join(dir, '90-libershare.conf');
		const rollback = await writeFileAtomically(path, 'new\n');
		await rollback();
		expect(await readdir(dir)).toEqual([]);
	});

	/**
	 * The unknown case, which is neither of the two above: the original is there and could
	 * not be read. Taking that for "there was nothing here" gives the rollback a null
	 * previous, and null means delete — so an unreadable live configuration would be
	 * REMOVED by the undo of a write that was reported as failed.
	 */
	it('refuses the write when the original could not be read', async () => {
		const path = join(dir, '90-libershare.conf');
		await writeFile(path, 'original\n', 'utf8');
		const denied = (): Promise<string> => Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
		await expect(writeFileAtomically(path, 'replacement\n', denied)).rejects.toMatchObject({ code: 'EACCES' });
		// Nothing was touched: no staging file left behind and the original still stands.
		expect(await readFile(path, 'utf8')).toBe('original\n');
		expect(await readdir(dir)).toEqual(['90-libershare.conf']);
	});

	it('still treats a genuinely absent original as nothing to restore', async () => {
		const path = join(dir, '90-libershare.conf');
		const missing = (): Promise<string> => Promise.reject(Object.assign(new Error('no such file'), { code: 'ENOENT' }));
		const rollback = await writeFileAtomically(path, 'new\n', missing);
		expect(await rollback()).toBe(true);
		expect(await readdir(dir)).toEqual([]);
	});
});

describe('applyTimesyncdDropIn', () => {
	let path = '';
	let dir = '';

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'lish-time-'));
		path = join(dir, '90-libershare.conf');
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('pins the server and restarts the daemon while synchronisation is on', async () => {
		const { exec, calls } = fakeRunner([]);
		expect(await applyTimesyncdDropIn('ntp.example.org', true, path, exec)).toEqual({ success: true, outcome: 'ok', message: null });
		expect(await readFile(path, 'utf8')).toBe('[Time]\nNTP=\nNTP=ntp.example.org\n');
		expect(calls).toEqual(['systemctl restart systemd-timesyncd']);
	});

	it('writes the drop-in and runs nothing while synchronisation is off', async () => {
		const { exec, calls } = fakeRunner([]);
		expect((await applyTimesyncdDropIn('ntp.example.org', false, path, exec)).outcome).toBe('ok');
		expect(await readFile(path, 'utf8')).toContain('NTP=ntp.example.org');
		expect(calls).toEqual([]);
	});

	/**
	 * The API reported a failure, so the host must not quietly adopt the new server at
	 * the next boot — the file goes back and the daemon is restarted onto it again.
	 */
	it('restores the previous drop-in when the restart fails', async () => {
		await writeFile(path, '[Time]\nNTP=\nNTP=old.example.org\n', 'utf8');
		const { exec, calls } = fakeRunner([{ kind: 'failed', code: 1, output: 'Job for systemd-timesyncd.service failed.\n' }]);
		const r = await applyTimesyncdDropIn('new.example.org', true, path, exec);
		expect(r.success).toBe(false);
		expect(r.outcome).toBe('error');
		expect(await readFile(path, 'utf8')).toBe('[Time]\nNTP=\nNTP=old.example.org\n');
		expect(calls).toEqual(['systemctl restart systemd-timesyncd', 'systemctl restart systemd-timesyncd']);
	});

	/**
	 * The file went back and the daemon did not. Swallowing that second restart reported an
	 * undo that only half happened — the drop-in on disk is the old one, and the daemon is
	 * either down or still running the withdrawn configuration.
	 */
	it('says so when the daemon could not be restarted onto the restored drop-in', async () => {
		await writeFile(path, '[Time]\nNTP=\nNTP=old.example.org\n', 'utf8');
		const failure: RunOutcome = { kind: 'failed', code: 1, output: 'Job for systemd-timesyncd.service failed.\n' };
		const { exec } = fakeRunner([failure, failure]);
		const r = await applyTimesyncdDropIn('new.example.org', true, path, exec);
		expect(r.success).toBe(false);
		expect(await readFile(path, 'utf8')).toBe('[Time]\nNTP=\nNTP=old.example.org\n');
		expect(r.message).toContain('could not be restarted onto it');
	});

	/**
	 * A restart onto an unrestored file is worse than no restart at all: the file on disk is
	 * still the new server, so the second restart can SUCCEED and make the rejected
	 * configuration live at once — while the caller is told the change could not be applied.
	 * The restore failure has to stop the sequence, not merely change the message after it.
	 *
	 * The restore is broken from inside the failing restart, which is the one moment between
	 * the write and the rollback: the drop-in is swapped for a directory, so putting the old
	 * content back cannot work.
	 */
	it('does not restart the daemon again when the drop-in could not be restored', async () => {
		await writeFile(path, '[Time]\nNTP=\nNTP=old.example.org\n', 'utf8');
		const calls: string[] = [];
		const exec: CommandRunner = async (cmd, args) => {
			calls.push([cmd, ...args].join(' '));
			await rm(path, { force: true });
			await mkdir(path);
			return { kind: 'failed', code: 1, output: 'Job for systemd-timesyncd.service failed.\n' };
		};
		const r = await applyTimesyncdDropIn('new.example.org', true, path, exec);
		expect(r.success).toBe(false);
		expect(calls).toEqual(['systemctl restart systemd-timesyncd']);
		expect(r.message).toContain('could not be restored');
	});

	it('removes a drop-in it created when the restart fails', async () => {
		const { exec } = fakeRunner([{ kind: 'failed', code: 1, output: 'Job for systemd-timesyncd.service failed.\n' }]);
		expect((await applyTimesyncdDropIn('new.example.org', true, path, exec)).success).toBe(false);
		expect(await readdir(dir)).toEqual([]);
	});

	/**
	 * Two saves in flight at once must not interleave. The daemon restart is what makes
	 * a drop-in take effect, so each call has to restart onto the file IT wrote — if both
	 * restarts see the same content, one caller was told its server is live while the
	 * other's file is the one on disk.
	 */
	it('keeps two concurrent writes from interleaving', async () => {
		const seenAtRestart: string[] = [];
		const exec: CommandRunner = async () => {
			// Wide enough that an unserialized second write would land first — both
			// writes finish in well under a millisecond.
			await new Promise(resolve => setTimeout(resolve, 10));
			seenAtRestart.push(await readFile(path, 'utf8'));
			return { kind: 'ok', output: '' };
		};
		const [a, b] = await Promise.all([applyTimesyncdDropIn('a.example.org', true, path, exec), applyTimesyncdDropIn('b.example.org', true, path, exec)]);
		expect([a.success, b.success]).toEqual([true, true]);
		expect(seenAtRestart.map(text => text.trim().split('NTP=').pop()).sort()).toEqual(['a.example.org', 'b.example.org']);
		// The loser's content is gone, and neither call left a staging file behind.
		expect(await readdir(dir)).toEqual(['90-libershare.conf']);
	});

	/**
	 * The way the lock itself could fail. The API layer takes it around the whole request
	 * and the writer takes it again inside — so if the re-entrant check ever stops seeing
	 * that this call stack already holds it, the inner acquisition waits for the outer one
	 * forever and every system-time request hangs. The test's own timeout is the assertion.
	 */
	it('does not deadlock when a locked write nests inside another', async () => {
		const { exec, calls } = fakeRunner([]);
		const r = await withSystemTimeLock(async () => applyTimesyncdDropIn('ntp.example.org', true, path, exec));
		expect(r.success).toBe(true);
		expect(calls).toEqual(['systemctl restart systemd-timesyncd']);
	});

	/** And still serializes afterwards: the nesting must release the lock, not leak it. */
	it('serializes again once a nested write is done', async () => {
		const { exec } = fakeRunner([]);
		await withSystemTimeLock(async () => applyTimesyncdDropIn('first.example.org', false, path, exec));
		expect((await applyTimesyncdDropIn('second.example.org', false, path, exec)).success).toBe(true);
		expect(await readFile(path, 'utf8')).toContain('second.example.org');
	});

	it('reports an unwritable drop-in as a permission problem and runs nothing', async () => {
		const { exec, calls } = fakeRunner([]);
		// A path whose parent is an existing FILE cannot be created on any platform.
		const blocked = join(path, 'nested.conf');
		await writeFile(path, 'x', 'utf8');
		const r = await applyTimesyncdDropIn('ntp.example.org', true, blocked, exec);
		expect(r.success).toBe(false);
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

describe('the write lock covers every writer', () => {
	/**
	 * Start `write` while another system-time write holds the lock and report whether it
	 * waited. A writer that never takes the lock settles straight away.
	 */
	async function waitsForTheLock(write: () => Promise<unknown>): Promise<boolean> {
		let release = (): void => {};
		const held = new Promise<void>(resolve => {
			release = resolve;
		});
		let settled = false;
		const holder = withSystemTimeLock(() => held);
		const pending = write().then(() => {
			settled = true;
		});
		await new Promise(resolve => setTimeout(resolve, 20));
		const waited = !settled;
		release();
		await holder;
		await pending;
		return waited;
	}

	/**
	 * The clock decides whether it may be written at all from a status read a moment
	 * earlier, so a `setNtpEnabled(true)` landing between that read and the command turns
	 * "synchronisation is off, this is the user's to set" into a clock the daemon steps
	 * back seconds later. It was the one writer whose read-then-decide-then-write was not
	 * a critical section, while the lock's own comment said it was.
	 */
	it('holds a clock set behind another write', async () => {
		const syncing = async (): Promise<SystemTimeStatus> => statusFixture({ ntpEnabled: true });
		const { exec } = fakeRunner([]);
		expect(await waitsForTheLock(() => setSystemClock(1, 2, 3, syncing, exec))).toBe(true);
	});

	/** The zone is what a clock reading is interpreted against, so it belongs in the same queue. */
	it('holds a timezone set behind another write', async () => {
		const refused: CommandRunner = async () => ({ kind: 'failed', code: 1, output: 'refused' });
		expect(await waitsForTheLock(() => setSystemTimezone(listSystemTimezones()[0]!, refused))).toBe(true);
	});

	/** Both still run: waiting for the lock must not mean waiting forever. */
	it('lets a clock set through once the lock is free', async () => {
		const syncing = async (): Promise<SystemTimeStatus> => statusFixture({ ntpEnabled: true });
		const { exec, calls } = fakeRunner([]);
		expect((await setSystemClock(1, 2, 3, syncing, exec)).outcome).toBe('auto-sync-enabled');
		expect(calls).toEqual([]);
	});
});

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

	/**
	 * The dangerous direction. A read that failed says nothing about whether a daemon
	 * owns the clock, and accepting the write would let it be stepped back seconds later
	 * — looking to the user as though the clock had silently refused to change.
	 */
	it('refuses while the sync state could not be read at all', () => {
		const refusal = clockWriteRefusal(statusFixture({ ntpEnabled: null }));
		expect(refusal?.success).toBe(false);
		expect(refusal?.outcome).toBe('error');
		expect(refusal?.message).toContain('cannot determine');
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
			// Unknown, not "off": nothing was read, so nothing may be claimed.
			expect(status.ntpEnabled).toBeNull();
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

describe('parseTzutilZone', () => {
	it('reads the identifier tzutil /g prints', () => {
		expect(parseTzutilZone('Central Europe Standard Time\r\n')).toBe('Central Europe Standard Time');
		expect(parseTzutilZone('UTC')).toBe('UTC');
	});

	/** Windows appends this when daylight saving is switched off; it is not part of the ID. */
	it('drops the daylight-saving-off suffix', () => {
		expect(parseTzutilZone('Central Europe Standard Time_dstoff\r\n')).toBe('Central Europe Standard Time');
	});

	it('returns null when nothing was read', () => {
		expect(parseTzutilZone(null)).toBeNull();
		expect(parseTzutilZone('')).toBeNull();
		expect(parseTzutilZone('  \r\n')).toBeNull();
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

describe('windowsToIanaTimezone caching', () => {
	/**
	 * Several IANA zones map to one Windows identifier, so a zone change need not change
	 * what `tzutil /g` answers. The cache was keyed on that identifier alone and kept
	 * reporting the zone from before the change — the UI showed the user's own change
	 * reverting itself.
	 */
	it('reports the zone last written for a shared windows identifier', () => {
		rememberWindowsZone('Central Europe Standard Time', 'Europe/Prague');
		expect(windowsToIanaTimezone('Central Europe Standard Time')).toBe('Europe/Prague');
		rememberWindowsZone('Central Europe Standard Time', 'Europe/Budapest');
		expect(windowsToIanaTimezone('Central Europe Standard Time')).toBe('Europe/Budapest');
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

	/**
	 * What turns `tzutil /g` into something the rest of the application understands. The
	 * zone here is deliberately not the host's, so the answer cannot come from the
	 * process's own timezone.
	 *
	 * The mapping is many-to-one — five IANA zones share `Tokyo Standard Time` — so the
	 * assertion is that the answer maps BACK to the same Windows zone, not that it is one
	 * particular city. Only the host's own zone gets to be exact (next test).
	 */
	it('maps a Windows identifier back to an IANA one in the same zone', () => {
		const iana = windowsToIanaTimezone('Tokyo Standard Time');
		expect(iana).not.toBeNull();
		expect(ianaToWindowsTimezoneId(iana!)).toBe('Tokyo Standard Time');
		expect(timezoneOffsetMinutes(iana!, new Date('2026-08-14T12:00:00Z'))).toBe(540);
		expect(windowsToIanaTimezone('UTC')).toBe('UTC');
	});

	it('round-trips whatever tzutil reports for this host', () => {
		const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const windowsId = ianaToWindowsTimezoneId(own);
		expect(windowsId).not.toBeNull();
		// Several IANA zones share one Windows zone, so the host's own must win over
		// CLDR's representative city — otherwise a status read renames the user's zone.
		expect(windowsToIanaTimezone(windowsId!)).toBe(own);
	});

	it('returns null for a Windows identifier no IANA zone maps to', () => {
		expect(windowsToIanaTimezone('Not A Real Standard Time')).toBeNull();
	});
});
