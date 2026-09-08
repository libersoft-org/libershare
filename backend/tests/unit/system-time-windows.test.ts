import { describe, expect, it } from 'bun:test';
import { buildSetTimezoneCommands, parseRegValue, parseTzutilZone, rememberWindowsZone, windowsToIanaTimezone, timezoneOffsetMinutes, parseWindowsNtpServer, parseWindowsStartMode, parseWindowsSyncMode, parseWindowsSyncStatus, windowsSyncEnabled, windowsSyncIsOurs, readWindowsPolicyManaged } from '../../src/system-time.ts';
import { canConvertTimezoneId, ianaToWindowsTimezoneId, probeDomainMembership, probeLocalMachineKey, type RegistryKeyProbe, type RegistryKeyState } from '../../src/system-time-windows.ts';
import { W32TM_STATUS } from '../helpers/system-time-fixtures.ts';

/** `reg query HKLM\\...\\W32Time\\Parameters`, CRLF and mixed value kinds as captured. */
const REG_QUERY_PARAMS = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\W32Time\\Parameters\r\n    NtpServer    REG_SZ    time.windows.com,0x9\r\n    ServiceDll    REG_EXPAND_SZ    %systemroot%\\system32\\w32time.dll\r\n    ServiceDllUnloadOnStop    REG_DWORD    0x1\r\n    ServiceMain    REG_SZ    SvchostEntry_W32Time\r\n    Type    REG_SZ    NTP\r\n\r\n';

/** The same key on a domain member, where the Active Directory hierarchy is the source. */
const REG_QUERY_PARAMS_DOMAIN = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\W32Time\\Parameters\r\n    NtpServer    REG_SZ    dc1.example.org,0x9 dc2.example.org,0x9\r\n    Type    REG_SZ    NT5DS\r\n\r\n';

/** `reg query HKLM\\...\\Services\\W32Time /v Start`, one per start type. */
const REG_QUERY_START_AUTO = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\W32Time\r\n    Start    REG_DWORD    0x2\r\n\r\n';

const REG_QUERY_START_DEMAND = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\W32Time\r\n    Start    REG_DWORD    0x3\r\n\r\n';

const REG_QUERY_START_DISABLED = '\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\W32Time\r\n    Start    REG_DWORD    0x4\r\n\r\n';

/** `w32tm /query /status` on a clock that has never been synchronised. */
const W32TM_STATUS_NEVER = 'Leap Indicator: 3(not synchronized)\r\nStratum: 0 (unspecified)\r\nLast Successful Sync Time: unspecified\r\nSource: Local CMOS Clock\r\n';

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
		for (const mode of ['domain-hierarchy', 'manual', 'all'] as const) expect(windowsSyncEnabled(mode, 'automatic')).toBe(true);
	});

	it.each(['automatic', 'on-demand', 'disabled', 'unknown'] as const)('does not infer effective synchronization from managed ownership and start=%s', start => {
		expect(windowsSyncEnabled('managed', start)).toBeNull();
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

	it('prefers current loss of synchronization over a historical successful timestamp', () => {
		expect(parseWindowsSyncStatus(W32TM_STATUS.replace('0(no warning)', '3(not synchronized)'))).toBe(false);
	});

	it.each([0, 1, 2])('accepts synchronized leap indicator %i without parsing the localized timestamp', indicator => {
		expect(parseWindowsSyncStatus(`Leap Indicator: ${indicator}\nLast Successful Sync Time: 08/14/2026 8:55:55 PM\n`)).toBe(true);
	});

	it.each(['\n', '\r\n'])('does not consume the next field after an empty value with %j', newline => {
		expect(parseWindowsSyncStatus(`Leap Indicator: 0${newline}Last Successful Sync Time: \t${newline}Source: ntp.example.org${newline}`)).toBeNull();
		expect(parseWindowsSyncStatus(`Leap Indicator: \t${newline}Last Successful Sync Time: 14.08.2026 20:55:55${newline}`)).toBeNull();
	});

	it.each(['', '4', 'unknown', '30', '0 invalid'])('does not infer current synchronization from history when the leap indicator is %j', indicator => {
		expect(parseWindowsSyncStatus(`Leap Indicator: ${indicator}\nLast Successful Sync Time: 14.08.2026 20:55:55\n`)).toBeNull();
	});

	it('returns unknown for missing or unrecognized localized status fields', () => {
		expect(parseWindowsSyncStatus('Last Successful Sync Time: 14.08.2026 20:55:55\n')).toBeNull();
		expect(parseWindowsSyncStatus('Sprungindikator: 0\nLetzte erfolgreiche Synchronisierungszeit: 14.08.2026 20:55:55\n')).toBeNull();
		expect(parseWindowsSyncStatus('Leap Indicator: 0\nLetzte erfolgreiche Synchronisierungszeit: 14.08.2026 20:55:55\n')).toBeNull();
	});

	it('rejects duplicate status fields instead of selecting a possibly stale answer', () => {
		expect(parseWindowsSyncStatus(W32TM_STATUS + 'Leap Indicator: 3(not synchronized)\r\n')).toBeNull();
		expect(parseWindowsSyncStatus(W32TM_STATUS + 'Last Successful Sync Time: unspecified\r\n')).toBeNull();
	});

	it.each(['unknown', 'not available', 'nicht angegeben'])('does not mistake the timestamp marker %j for a successful sync', value => {
		expect(parseWindowsSyncStatus(`Leap Indicator: 0\nLast Successful Sync Time: ${value}\n`)).toBeNull();
	});

	it('returns null when the field is absent or has no value', () => {
		expect(parseWindowsSyncStatus('Stratum: 5\r\n')).toBeNull();
		expect(parseWindowsSyncStatus('Last Successful Sync Time: \r\n')).toBeNull();
		expect(parseWindowsSyncStatus('')).toBeNull();
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

describe('probeDomainMembership', () => {
	/** Never throws, and answers one of the three states, on Windows and off it alike. */
	it('answers a join state rather than throwing', () => {
		expect(['domain', 'standalone', 'unknown']).toContain(probeDomainMembership());
	});

	/**
	 * On the host this suite runs on the answer has to agree with what Windows itself
	 * reports, which is the only part of the probe a test can check against reality.
	 * Elsewhere there is no join state to be right about.
	 */
	it('agrees with the host it runs on', () => {
		if (process.platform !== 'win32') {
			expect(probeDomainMembership()).toBe('unknown');
			return;
		}
		expect(['domain', 'standalone']).toContain(probeDomainMembership());
	});
});

describe('windowsSyncIsOurs', () => {
	it('allows a change only where this application configured the source itself', () => {
		expect(windowsSyncIsOurs('manual', 'standalone')).toBe(true);
		expect(windowsSyncIsOurs('none', 'standalone')).toBe(true);
	});

	/**
	 * A domain member, a policy-managed host and an unidentifiable one are all somebody
	 * else's configuration. The capability being false is what keeps the UI from
	 * offering a change that would detach the machine from its domain's time.
	 */
	it('refuses a domain, policy-managed or unidentified host', () => {
		expect(windowsSyncIsOurs('domain-hierarchy', 'standalone')).toBe(false);
		expect(windowsSyncIsOurs('managed', 'standalone')).toBe(false);
		expect(windowsSyncIsOurs('unknown', 'standalone')).toBe(false);
	});

	/**
	 * AllSync is every available source at once, the AD hierarchy included. It used to be
	 * treated as ours, which let the toggle stop and disable W32Time on a domain member
	 * configured that way.
	 */
	it('refuses a host synchronising from every available source', () => {
		expect(windowsSyncIsOurs('all', 'standalone')).toBe(false);
	});

	/**
	 * The forest-root PDC case. Pointed at an external time source the Microsoft-documented
	 * way it carries local `Type=NTP` and no policy branch, so the mode alone reads exactly
	 * like a workgroup machine with a peer list — while it is the clock the entire forest
	 * follows. Treated as ours, the off switch stopped and disabled W32Time on it for good.
	 */
	it('refuses a domain member whose source looks like a plain peer list', () => {
		expect(windowsSyncIsOurs('manual', 'domain')).toBe(false);
		expect(windowsSyncIsOurs('none', 'domain')).toBe(false);
	});

	/** An unreadable join state may be a domain member, so it is refused like one. */
	it('refuses a host whose domain membership could not be established', () => {
		expect(windowsSyncIsOurs('manual', 'unknown')).toBe(false);
		expect(windowsSyncIsOurs('none', 'unknown')).toBe(false);
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
