import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canConfigureTimesyncdServer, competingNtpUnits, COMPETING_NTP_UNITS, parseAnyUnitActive, buildTimesyncdDropIn, parseUnitLoadStates, extractWords, extractWordsChecked, readNtpUnitsList, readTimedatedEnvironment, type CommandRunner, type RunOutcome, TIMESYNCD_DROPIN_PATH, TIMESYNCD_UNIT } from '../../src/system-time.ts';

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
	/** `systemctl show -p Id -p LoadState <units...>` — one record per unit, blank-separated. */
	const show = (...units: [string, string][]): string => units.map(([id, load]) => `Id=${id}\nLoadState=${load}\n`).join('\n');
	const INSTALLED = show(['systemd-timesyncd.service', 'loaded']);
	const ABSENT = show(['systemd-timesyncd.service', 'not-found']);
	const CHRONY_ACTIVE = 'active\n\ninactive\n\ninactive\n\ninactive\n\ninactive\n';
	const NONE_ACTIVE = 'inactive\n\ninactive\n\ninactive\n\ninactive\n\ninactive\n';

	const BOTH_INSTALLED = show(['chronyd.service', 'loaded'], ['systemd-timesyncd.service', 'loaded']);
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

	/**
	 * An ordering may name a provider through an alias, and systemd answers for it under the
	 * ALIASED unit's `Id`. Both directions were wrong before: an alias for chrony was read as
	 * a unit that is not there, so the ordering skipped it and permitted the write while
	 * `set-ntp` would start chrony — and an alias for timesyncd compared unequal to it, so a
	 * host that is ours to configure was reported as somebody else's.
	 */
	it('follows an alias to the unit it names', () => {
		const ALIASED = ['vendor-ntp.service', 'systemd-timesyncd.service'];
		const toChrony = `Id=chronyd.service\nNames=vendor-ntp.service chronyd.service\nLoadState=loaded\n\n${show(['systemd-timesyncd.service', 'loaded'])}`;
		expect(canConfigureTimesyncdServer(ALIASED, toChrony, NONE_ACTIVE)).toBe(false);
		const toTimesyncd = `Id=systemd-timesyncd.service\nNames=vendor-ntp.service systemd-timesyncd.service\nLoadState=loaded\n`;
		expect(canConfigureTimesyncdServer(ALIASED, toTimesyncd, NONE_ACTIVE)).toBe(true);
	});

	/**
	 * The gap `list-unit-files` left. It answers about the unit FILE, so a unit whose file is
	 * on disk but will not load — a bad setting, a parse error — was read as a usable
	 * provider. timedated selects on `LoadState == loaded` and skips it, so the drop-in was
	 * written for a daemon that never gets the clock.
	 */
	it('refuses a unit that is on disk but does not load', () => {
		expect(canConfigureTimesyncdServer([], show(['systemd-timesyncd.service', 'bad-setting']), NONE_ACTIVE)).toBe(false);
		expect(canConfigureTimesyncdServer(TIMESYNCD_FIRST, show(['systemd-timesyncd.service', 'error']), NONE_ACTIVE)).toBe(false);
		expect(canConfigureTimesyncdServer([], show(['systemd-timesyncd.service', 'masked']), NONE_ACTIVE)).toBe(false);
	});

	/** And the same rule the other way: a broken leader is skipped, exactly as timedated skips it. */
	it('looks past a leading provider whose unit does not load', () => {
		expect(canConfigureTimesyncdServer(CHRONY_FIRST, show(['chronyd.service', 'bad-setting'], ['systemd-timesyncd.service', 'loaded']), NONE_ACTIVE)).toBe(true);
	});

	it('names every implementation timedated can hand the clock to', () => {
		expect(COMPETING_NTP_UNITS).toContain('chronyd.service');
		expect(COMPETING_NTP_UNITS).toContain('ntpd.service');
		expect(COMPETING_NTP_UNITS.every(u => u.endsWith('.service'))).toBe(true);
	});
});

describe('competingNtpUnits', () => {
	it('keeps the known implementations when the host adds nothing', () => {
		expect(competingNtpUnits([TIMESYNCD_UNIT]).sort()).toEqual([...COMPETING_NTP_UNITS].sort());
		expect(competingNtpUnits(null).sort()).toEqual([...COMPETING_NTP_UNITS].sort());
	});

	/**
	 * The gap the hardcoded five leave: timedated takes any unit name from its ordered list,
	 * so a distribution's or an administrator's own provider is one it will happily hand the
	 * clock to and one nothing here would have asked about.
	 */
	it('adds a provider from the host ordering that is on no list', () => {
		expect(competingNtpUnits(['50-vendor-timed.service', TIMESYNCD_UNIT])).toContain('50-vendor-timed.service');
	});

	/** timesyncd is the daemon we configure, so it is never its own competitor. */
	it('never asks about timesyncd itself', () => {
		expect(competingNtpUnits(['chronyd.service', TIMESYNCD_UNIT])).not.toContain(TIMESYNCD_UNIT);
	});

	it('does not ask twice about a unit that is on both lists', () => {
		const units = competingNtpUnits(['chronyd.service', TIMESYNCD_UNIT]);
		expect(units.filter(u => u === 'chronyd.service')).toHaveLength(1);
	});

	/**
	 * Excluded by identity, not by spelling: an alias for timesyncd is a different string, so
	 * it stayed on the competitor list and timesyncd running normally answered as a rival
	 * daemon — the capability went false on a host that is ours to configure.
	 */
	it('excludes an alias that names timesyncd', () => {
		const states = parseUnitLoadStates('Id=systemd-timesyncd.service\nNames=vendor-ntp.service systemd-timesyncd.service\nLoadState=loaded\n');
		expect(competingNtpUnits(['vendor-ntp.service'], states)).not.toContain('vendor-ntp.service');
	});

	/**
	 * The same rule, applied to the hardcoded names rather than to the ordering. A host that
	 * aliases `chronyd.service` onto timesyncd answers for it with timesyncd's own
	 * `ActiveState`, so a perfectly ordinary running timesyncd read as chrony holding the
	 * clock and the server could not be configured.
	 */
	it('drops a hardcoded name that is an alias of timesyncd', () => {
		const states = parseUnitLoadStates(`Id=${TIMESYNCD_UNIT}\nNames=${TIMESYNCD_UNIT} chronyd.service\nLoadState=loaded\n`);
		expect(competingNtpUnits([TIMESYNCD_UNIT], states)).not.toContain('chronyd.service');
		// The other hardcoded names are about other daemons and stay.
		expect(competingNtpUnits([TIMESYNCD_UNIT], states)).toContain('ntpd.service');
	});

	it('keeps an alias that names another daemon', () => {
		const states = parseUnitLoadStates('Id=chronyd.service\nNames=vendor-ntp.service chronyd.service\nLoadState=loaded\n');
		expect(competingNtpUnits(['vendor-ntp.service'], states)).toContain('vendor-ntp.service');
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
		expect(await readNtpUnitsList({}, [lib])).toEqual(['chronyd.service', 'systemd-timesyncd.service']);
	});

	it('lets an earlier directory shadow the same file name in a later one', async () => {
		const etc = await dir('etc', { '50-chronyd.list': 'replacement.service\n' });
		const lib = await dir('lib', { '50-chronyd.list': 'chronyd.service\n', '80-systemd-timesync.list': 'systemd-timesyncd.service\n' });
		expect(await readNtpUnitsList({}, [etc, lib])).toEqual(['replacement.service', 'systemd-timesyncd.service']);
	});

	it('skips comments, blank lines and repeats, and ignores files that are not lists', async () => {
		const lib = await dir('lib', { '50-a.list': '# a comment\n\nchronyd.service\nchronyd.service\n', README: 'ntpd.service\n' });
		expect(await readNtpUnitsList({}, [lib])).toEqual(['chronyd.service']);
	});

	it('takes the environment override in place of the directories', async () => {
		const lib = await dir('lib', { '50-chronyd.list': 'chronyd.service\n' });
		expect(await readNtpUnitsList({ SYSTEMD_TIMEDATED_NTP_SERVICES: 'ntpsec.service:systemd-timesyncd.service' }, [lib])).toEqual(['ntpsec.service', 'systemd-timesyncd.service']);
	});

	it('reports no ordering at all on a host without the directories', async () => {
		expect(await readNtpUnitsList({}, [join(root, 'nowhere')])).toEqual([]);
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
		expect(await readNtpUnitsList({}, [notADirectory, lib])).toBeNull();
	});

	it('reports an unknown ordering when a list file cannot be read', async () => {
		const lib = await dir('lib', {});
		await mkdir(join(lib, '50-chronyd.list'));
		expect(await readNtpUnitsList({}, [lib])).toBeNull();
	});

	/**
	 * An environment that could not be established is an unknown ordering, not an absent
	 * override: the variable it might carry replaces the directories outright, so the
	 * directory ordering cannot stand in for it.
	 */
	it('reports an unknown ordering when timedated s environment could not be read', async () => {
		const lib = await dir('lib', { '50-chronyd.list': 'chronyd.service\n' });
		expect(await readNtpUnitsList(null, [lib])).toBeNull();
	});

	/**
	 * timedated validates each entry and ignores the ones that are not unit names. Keeping
	 * them would also take the `systemctl show` that follows down with them — one malformed
	 * line in a vendor list file would turn the capability off on a healthy host.
	 */
	it('drops entries that are not valid unit names', async () => {
		const lib = await dir('lib', { '50-a.list': 'not a unit name\nchronyd.service\nno-suffix\n' });
		expect(await readNtpUnitsList({}, [lib])).toEqual(['chronyd.service']);
		expect(await readNtpUnitsList({ SYSTEMD_TIMEDATED_NTP_SERVICES: 'bad name:chronyd.service' }, [lib])).toEqual(['chronyd.service']);
	});

	/**
	 * timedated reads this list with `extract_first_word(&p, &word, ":", 0)`, where a
	 * backslash escapes the next character. A plain `split(':')` cut such a name in half and
	 * dropped both halves as invalid, so the provider timedated would actually start was not
	 * in our ordering at all.
	 */
	it('does not split the override on an escaped colon', async () => {
		const lib = await dir('lib', { '50-chronyd.list': 'chronyd.service\n' });
		expect(await readNtpUnitsList({ SYSTEMD_TIMEDATED_NTP_SERVICES: 'weird\\:name.service:chronyd.service' }, [lib])).toEqual(['weird:name.service', 'chronyd.service']);
	});

	/**
	 * `UNIT_NAME_PLAIN` is what timedated validates against, and it is narrower than "looks
	 * like a unit name". An instance or template name is ignored outright upstream, so
	 * accepting one here named a first usable provider timedated would never start — and an
	 * unknown suffix fails the shared `systemctl show`, turning the capability off on a
	 * healthy host where timedated would simply have moved on to the next entry.
	 */
	it('rejects instance names, template names and unknown unit types', async () => {
		const lib = await dir('lib', { '50-a.list': 'foo@bar.service\nfoo@.service\nfoo.waldo\n.service\nchronyd.service\n' });
		expect(await readNtpUnitsList({}, [lib])).toEqual(['chronyd.service']);
	});

	it('accepts the unit types systemd has', async () => {
		const lib = await dir('lib', { '50-a.list': 'a.service\nb.socket\nc.target\nd.timer\ne.path\nf.slice\n' });
		expect(await readNtpUnitsList({}, [lib])).toEqual(['a.service', 'b.socket', 'c.target', 'd.timer', 'e.path', 'f.slice']);
	});

	/**
	 * timedated stops at the syntax error and keeps what it had — and because the variable
	 * exists, it never falls back to the list files. Emitting the half-read entry gave us a
	 * provider the host never named, and one we then judged loaded.
	 */
	it('stops the override at a trailing backslash without falling back to the files', async () => {
		const lib = await dir('lib', { '50-chronyd.list': 'chronyd.service\n' });
		expect(await readNtpUnitsList({ SYSTEMD_TIMEDATED_NTP_SERVICES: 'missing.service:systemd-timesyncd.service\\' }, [lib])).toEqual(['missing.service']);
	});

	it('coalesces empty entries in the override the way systemd does', async () => {
		const lib = await dir('lib', {});
		expect(await readNtpUnitsList({ SYSTEMD_TIMEDATED_NTP_SERVICES: ':chronyd.service::ntpd.service:' }, [lib])).toEqual(['chronyd.service', 'ntpd.service']);
	});
});

describe('extractWords', () => {
	it('splits on the separator and coalesces runs of it', () => {
		expect(extractWords('a:b::c', false, ':')).toEqual(['a', 'b', 'c']);
	});

	it('keeps an escaped separator inside the word', () => {
		expect(extractWords('a\\:b:c', false, ':')).toEqual(['a:b', 'c']);
	});

	/** With `EXTRACT_UNQUOTE` clear, a quote is an ordinary character — timedated's own flags. */
	it('leaves quotes alone when it is not unquoting', () => {
		expect(extractWords('"a b"', false)).toEqual(['"a', 'b"']);
	});

	it('keeps a quoted value together when it is unquoting', () => {
		expect(extractWords('A="a b" B=c', true)).toEqual(['A=a b', 'B=c']);
		expect(extractWords("A='a b'", true)).toEqual(['A=a b']);
	});

	it('reads every kind of whitespace systemd separates on', () => {
		expect(extractWords('a\tb\nc\r\nd', true)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('has nothing to say about an empty value', () => {
		expect(extractWords('', true)).toEqual([]);
		expect(extractWords('   ', true)).toEqual([]);
	});

	/**
	 * `extract_first_word` returns `-EINVAL` for a word ending in a bare backslash, so the
	 * word is not a word: timedated logs a syntax error and stops. Emitting it without the
	 * backslash invented a provider name the host never wrote — and timedated, having seen the
	 * variable, does not read the list files either, so the invented name was the ordering.
	 */
	it('drops a word left open by a trailing backslash and says so', () => {
		expect(extractWordsChecked('systemd-timesyncd.service\\', false, ':')).toEqual({ words: [], error: true });
	});

	it('keeps the words read before the trailing backslash', () => {
		expect(extractWordsChecked('missing.service:systemd-timesyncd.service\\', false, ':')).toEqual({ words: ['missing.service'], error: true });
	});

	/** A backslash that HAS a character behind it is an escape, not an error. */
	it('still preserves an escaped separator', () => {
		expect(extractWordsChecked('missing.service\\:alias.service', false, ':')).toEqual({ words: ['missing.service:alias.service'], error: false });
	});

	/** Unquoting mode has the second way to run out of input: a quote nothing closes. */
	it('reports a quote that is never closed', () => {
		expect(extractWordsChecked('A=1 B="unterminated', true)).toEqual({ words: ['A=1'], error: true });
		// Without `EXTRACT_UNQUOTE` a quote is an ordinary character and cannot be unclosed.
		expect(extractWordsChecked('B="unterminated', false)).toEqual({ words: ['B="unterminated'], error: false });
	});

	it('reports no error on a value that parses', () => {
		expect(extractWordsChecked('a:b', false, ':')).toEqual({ words: ['a', 'b'], error: false });
	});
});

describe('readTimedatedEnvironment', () => {
	/** Answer `systemctl show-environment` and `systemctl show -p Environment` separately. */
	function systemctl(manager: RunOutcome, unit: RunOutcome): CommandRunner {
		return async (_cmd, args) => (args[0] === 'show-environment' ? manager : unit);
	}

	const ok = (output: string): RunOutcome => ({ kind: 'ok', output });

	/**
	 * The unit's `systemctl show` answer, one `Key=Value` line per property systemd reports.
	 *
	 * `EnvironmentFiles` is left OUT when there is no file, because that is what a running
	 * systemd does: the empty list prints no line at all, while `Environment` and the other
	 * two print an empty value. A fixture that printed it empty would have tested a host
	 * shape that does not exist.
	 */
	function props(values: { LoadState?: string; Environment?: string; EnvironmentFiles?: string; PassEnvironment?: string; UnsetEnvironment?: string } = {}): RunOutcome {
		const files = values.EnvironmentFiles === undefined ? '' : `EnvironmentFiles=${values.EnvironmentFiles}\n`;
		return ok(`LoadState=${values.LoadState ?? 'loaded'}\nEnvironment=${values.Environment ?? ''}\n${files}PassEnvironment=${values.PassEnvironment ?? ''}\nUnsetEnvironment=${values.UnsetEnvironment ?? ''}\n`);
	}

	/**
	 * The whole point of the read: the override lives in TIMEDATED's environment. Ours is a
	 * different process and says nothing about which provider timedated would start.
	 */
	it('takes the override from the unit s own Environment', async () => {
		const env = await readTimedatedEnvironment(systemctl(ok('LANG=C\n'), props({ Environment: 'SYSTEMD_TIMEDATED_NTP_SERVICES=chronyd.service' })));
		expect(env?.['SYSTEMD_TIMEDATED_NTP_SERVICES']).toBe('chronyd.service');
	});

	/**
	 * A system service is not handed the manager's environment. Reading it as if it were
	 * gave timedated an override it never receives: it would start the first provider on
	 * disk while we configured the one the variable names.
	 */
	it('ignores a manager value the unit does not ask to have passed', async () => {
		const env = await readTimedatedEnvironment(systemctl(ok('SYSTEMD_TIMEDATED_NTP_SERVICES=ntpd.service\nLANG=C\n'), props()));
		expect(env?.['SYSTEMD_TIMEDATED_NTP_SERVICES']).toBeUndefined();
		expect(env?.['LANG']).toBeUndefined();
	});

	it('takes a manager value the unit names in PassEnvironment', async () => {
		const env = await readTimedatedEnvironment(systemctl(ok('SYSTEMD_TIMEDATED_NTP_SERVICES=ntpd.service\n'), props({ PassEnvironment: 'SYSTEMD_TIMEDATED_NTP_SERVICES' })));
		expect(env?.['SYSTEMD_TIMEDATED_NTP_SERVICES']).toBe('ntpd.service');
	});

	/** A service's own `Environment=` overrides what was passed in, so it is applied second. */
	it('lets Environment override a passed-through manager value', async () => {
		const env = await readTimedatedEnvironment(systemctl(ok('SYSTEMD_TIMEDATED_NTP_SERVICES=ntpd.service\n'), props({ PassEnvironment: 'SYSTEMD_TIMEDATED_NTP_SERVICES', Environment: 'SYSTEMD_TIMEDATED_NTP_SERVICES=chronyd.service' })));
		expect(env?.['SYSTEMD_TIMEDATED_NTP_SERVICES']).toBe('chronyd.service');
	});

	/** Applied last, and it can take away what either of the first two phases put there. */
	it('removes a variable UnsetEnvironment names', async () => {
		const env = await readTimedatedEnvironment(systemctl(ok('SYSTEMD_TIMEDATED_NTP_SERVICES=ntpd.service\n'), props({ PassEnvironment: 'SYSTEMD_TIMEDATED_NTP_SERVICES', UnsetEnvironment: 'SYSTEMD_TIMEDATED_NTP_SERVICES' })));
		expect(env?.['SYSTEMD_TIMEDATED_NTP_SERVICES']).toBeUndefined();
		const own = await readTimedatedEnvironment(systemctl(ok(''), props({ Environment: 'SYSTEMD_TIMEDATED_NTP_SERVICES=chronyd.service', UnsetEnvironment: 'SYSTEMD_TIMEDATED_NTP_SERVICES' })));
		expect(own?.['SYSTEMD_TIMEDATED_NTP_SERVICES']).toBeUndefined();
	});

	/** systemd removes a `NAME=value` entry only when the value is the one named. */
	it('removes an assignment from UnsetEnvironment only when the value matches', async () => {
		const kept = await readTimedatedEnvironment(systemctl(ok(''), props({ Environment: 'SYSTEMD_TIMEDATED_NTP_SERVICES=chronyd.service', UnsetEnvironment: 'SYSTEMD_TIMEDATED_NTP_SERVICES=ntpd.service' })));
		expect(kept?.['SYSTEMD_TIMEDATED_NTP_SERVICES']).toBe('chronyd.service');
		const gone = await readTimedatedEnvironment(systemctl(ok(''), props({ Environment: 'SYSTEMD_TIMEDATED_NTP_SERVICES=chronyd.service', UnsetEnvironment: 'SYSTEMD_TIMEDATED_NTP_SERVICES=chronyd.service' })));
		expect(gone?.['SYSTEMD_TIMEDATED_NTP_SERVICES']).toBeUndefined();
	});

	it('reads the several whitespace-separated entries Environment prints on one line', async () => {
		const env = await readTimedatedEnvironment(systemctl(ok(''), props({ Environment: 'A=1 SYSTEMD_TIMEDATED_NTP_SERVICES=chronyd.service:ntpd.service B=2' })));
		expect(env).toMatchObject({ A: '1', B: '2', SYSTEMD_TIMEDATED_NTP_SERVICES: 'chronyd.service:ntpd.service' });
	});

	/**
	 * systemd quotes the values it prints, so another variable's value can contain what
	 * looks like an assignment. Splitting on whitespace tore it out and invented an override
	 * the host never set — which decides which daemon we believe owns the clock.
	 */
	it('does not read an assignment out of another variable s quoted value', async () => {
		const env = await readTimedatedEnvironment(systemctl(ok(''), props({ Environment: 'GREETING="hello SYSTEMD_TIMEDATED_NTP_SERVICES=chronyd.service"' })));
		expect(env?.['SYSTEMD_TIMEDATED_NTP_SERVICES']).toBeUndefined();
		expect(env?.['GREETING']).toBe('hello SYSTEMD_TIMEDATED_NTP_SERVICES=chronyd.service');
	});

	it('reads a quoted manager value as one assignment', async () => {
		const env = await readTimedatedEnvironment(systemctl(ok('GREETING="hello SYSTEMD_TIMEDATED_NTP_SERVICES=chronyd.service"\n'), props({ PassEnvironment: 'GREETING' })));
		expect(env?.['SYSTEMD_TIMEDATED_NTP_SERVICES']).toBeUndefined();
		expect(env?.['GREETING']).toBe('hello SYSTEMD_TIMEDATED_NTP_SERVICES=chronyd.service');
	});

	it('reports no override on a host that sets none', async () => {
		const env = await readTimedatedEnvironment(systemctl(ok('LANG=C\nPATH=/usr/bin\n'), props()));
		expect(env?.['SYSTEMD_TIMEDATED_NTP_SERVICES']).toBeUndefined();
	});

	/**
	 * The file is a source of the same variable that we do not read. Reported as an unknown
	 * environment, it turns the capability off; reported as no override, it would have us
	 * write the timesyncd drop-in on a host whose timedated starts chronyd instead — and the
	 * competing-daemon check does not catch that, because a chrony that has not been started
	 * yet is not active.
	 */
	it('reports an unknown environment when the unit has an EnvironmentFile', async () => {
		const files = await readTimedatedEnvironment(systemctl(ok(''), props({ EnvironmentFiles: '/etc/systemd/timedated-provider.env (ignore_errors=no)' })));
		expect(files).toBeNull();
	});

	/**
	 * The ordinary host: no `EnvironmentFile`, so systemd prints no such line at all. That
	 * absence must not read as "unknown" or the capability would be off everywhere.
	 */
	it('reads the environment normally when the unit has no EnvironmentFile', async () => {
		const answer = props({ Environment: 'SYSTEMD_TIMEDATED_NTP_SERVICES=chronyd.service' });
		expect(answer.kind === 'ok' && answer.output).not.toContain('EnvironmentFiles');
		expect((await readTimedatedEnvironment(systemctl(ok(''), answer)))?.['SYSTEMD_TIMEDATED_NTP_SERVICES']).toBe('chronyd.service');
	});

	/**
	 * What that unknown environment costs, end to end: the ordering cannot be read, so the
	 * server may not be configured — even though chronyd is only installed, not running.
	 */
	it('leaves the server unconfigurable when an EnvironmentFile hides the ordering', async () => {
		const env = await readTimedatedEnvironment(systemctl(ok(''), props({ EnvironmentFiles: '/etc/systemd/timedated-provider.env (ignore_errors=no)' })));
		const ordered = await readNtpUnitsList(env);
		expect(ordered).toBeNull();
		const loaded = 'Id=chronyd.service\nNames=chronyd.service\nLoadState=loaded\n';
		expect(canConfigureTimesyncdServer(ordered, loaded, 'inactive\ninactive\n')).toBe(false);
	});

	/**
	 * A property the word parser refuses is a source that did not answer: everything after the
	 * error is unread, and the override that decides the provider may be exactly that.
	 */
	it('reports an unknown environment when a value does not parse', async () => {
		expect(await readTimedatedEnvironment(systemctl(ok('LANG=C\\'), props()))).toBeNull();
		expect(await readTimedatedEnvironment(systemctl(ok(''), props({ Environment: 'A="unterminated' })))).toBeNull();
	});

	/**
	 * `systemctl show` exits 0 for a unit that does not exist and prints every property empty,
	 * so a successful call is no evidence we read the unit we named. Taken as "timedated sets
	 * no override" it would hand the directory ordering the last word on a host we never
	 * actually asked about.
	 */
	it('reports an unknown environment when the unit is not loaded', async () => {
		const missing = props({ LoadState: 'not-found', Environment: '' });
		expect(await readTimedatedEnvironment(systemctl(ok(''), missing))).toBeNull();
		expect(await readTimedatedEnvironment(systemctl(ok(''), props({ LoadState: 'masked' })))).toBeNull();
		// Absent entirely — an older systemd, or a property name that answered nothing.
		expect(await readTimedatedEnvironment(systemctl(ok(''), ok('Environment=\n')))).toBeNull();
	});

	/** Either source could be the one carrying the override, so neither may be skipped. */
	it('reports an unknown environment when a source does not answer', async () => {
		const failed: RunOutcome = { kind: 'failed', code: 1, output: 'Failed to get properties.\n' };
		expect(await readTimedatedEnvironment(systemctl(failed, ok('')))).toBeNull();
		expect(await readTimedatedEnvironment(systemctl(ok(''), failed))).toBeNull();
		expect(await readTimedatedEnvironment(systemctl({ kind: 'missing' }, ok('')))).toBeNull();
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

describe('parseUnitLoadStates', () => {
	/** Two units as `systemctl show -p Id -p Names -p LoadState` prints them: records, blank-separated. */
	const TWO = 'Id=chronyd.service\nNames=chronyd.service\nLoadState=not-found\n\nId=systemd-timesyncd.service\nNames=systemd-timesyncd.service\nLoadState=loaded\n';

	it('keys each state by the unit systemd reported it for', () => {
		expect([...parseUnitLoadStates(TWO)]).toEqual([
			['chronyd.service', { id: 'chronyd.service', load: 'not-found' }],
			['systemd-timesyncd.service', { id: 'systemd-timesyncd.service', load: 'loaded' }],
		]);
	});

	/**
	 * Asking about an alias answers under the ALIASED unit's `Id`, so a map keyed on `Id`
	 * alone has nothing under the name that was asked about — the provider was read as absent
	 * and the ordering moved on to a daemon timedated would never have started.
	 */
	it('keys a record under its aliases as well as its Id', () => {
		const states = parseUnitLoadStates('Id=chronyd.service\nNames=vendor-ntp.service chronyd.service\nLoadState=loaded\n');
		expect(states.get('vendor-ntp.service')).toEqual({ id: 'chronyd.service', load: 'loaded' });
		expect(states.get('chronyd.service')).toEqual({ id: 'chronyd.service', load: 'loaded' });
	});

	/** A disabled unit still loads, and the drop-in applies the moment it is started. */
	it('reads a disabled unit as loaded', () => {
		expect(parseUnitLoadStates('Id=systemd-timesyncd.service\nLoadState=loaded\nUnitFileState=disabled\n').get('systemd-timesyncd.service')?.load).toBe('loaded');
	});

	it('carries masked and unparsable units through as themselves', () => {
		const states = parseUnitLoadStates('Id=a.service\nLoadState=masked\n\nId=b.service\nLoadState=bad-setting\n');
		expect(states.get('a.service')?.load).toBe('masked');
		expect(states.get('b.service')?.load).toBe('bad-setting');
	});

	it('is empty for empty output', () => {
		expect(parseUnitLoadStates('').size).toBe(0);
	});

	/** A record with no Id to key it on is dropped rather than attached to a neighbour. */
	it('drops a half record instead of misattributing it', () => {
		expect([...parseUnitLoadStates('LoadState=loaded\n\nId=a.service\nLoadState=masked\n')]).toEqual([['a.service', { id: 'a.service', load: 'masked' }]]);
	});

	/** systemd puts Id first, but back-to-back records without a blank line must not merge. */
	it('ends a record at the next Id even without a blank line', () => {
		expect([...parseUnitLoadStates('Id=a.service\nLoadState=loaded\nId=b.service\nLoadState=masked\n')]).toEqual([
			['a.service', { id: 'a.service', load: 'loaded' }],
			['b.service', { id: 'b.service', load: 'masked' }],
		]);
	});
});
