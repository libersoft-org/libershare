import { parseTimedatectlShow, type CommandRunner, run, type PlatformStatus, tryRead, UNREADABLE_STATUS, parseYesNo, isValidNtpServer } from './system-time-common.ts';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Drop-in that carries our NTP server on systemd hosts. A drop-in is used instead of
 * editing the shipped `timesyncd.conf` so a distribution package upgrade never fights
 * our value and removing the feature is a single file deletion.
 *
 * The `90-` prefix is not cosmetic: drop-ins are applied in lexicographic order and a
 * later file re-overrides the same key, so a distribution's `50-*.conf` would silently
 * beat a `10-` prefix while the API still reported success. systemd reserves 60-90 for
 * local administrative overrides in `/etc`, which is exactly what this is.
 */
export const TIMESYNCD_DROPIN_PATH = '/etc/systemd/timesyncd.conf.d/90-libershare.conf';

/** systemd unit that reads {@link TIMESYNCD_DROPIN_PATH}. */
export const TIMESYNCD_UNIT = 'systemd-timesyncd.service';

/**
 * Pick the NTP server to display from `timedatectl show-timesync`. `ServerName` is
 * the peer actually in use and wins, because a DHCP-supplied `LinkNTPServers` entry
 * silently overrides the configured `SystemNTPServers` list — showing the configured
 * value alone would claim a server that is not being used. Only the first entry is
 * reported: the UI configures exactly one server.
 */
export function parseTimesyncServer(output: string): string | null {
	const map = parseTimedatectlShow(output);
	const first = (value: string | undefined): string | null => {
		const token = (value ?? '').trim().split(/\s+/)[0];
		return token ? token : null;
	};
	return first(map['ServerName']) ?? first(map['SystemNTPServers']) ?? first(map['LinkNTPServers']) ?? first(map['FallbackNTPServers']);
}

/** Read the ordered files emitted by systemd-analyze, without guessing directory precedence. */
function parseTimesyncServerLists(output: string): Record<'NTP' | 'FallbackNTP', string[]> | null {
	if (output.includes('\0')) return null;
	const servers: Record<'NTP' | 'FallbackNTP', string[]> = { NTP: [], FallbackNTP: [] };
	let section = '';
	let continuation = '';
	let bomSeen = false;
	const strip = (value: string): string => value.replace(/^[ \t\r]+|[ \t\r]+$/g, '');
	const apply = (logical: string): boolean => {
		const line = strip(logical);
		if (!line) return true;
		if (line.startsWith('[')) {
			const match = /^\[([^\]]+)\]$/.exec(line);
			if (!match) return false;
			section = match[1]!;
			return true;
		}
		if (!section) return false;
		if (section !== 'Time') return true;
		const equals = line.indexOf('=');
		if (equals < 1) return false;
		const key = strip(line.slice(0, equals));
		if (key !== 'NTP' && key !== 'FallbackNTP') return true;
		const value = strip(line.slice(equals + 1));
		if (!value) {
			servers[key] = [];
			return true;
		}
		// timesyncd-conf.c uses extract_first_word(..., flags=0), not EXTRACT_UNQUOTE.
		const parsed = extractWordsChecked(value, false);
		if (parsed.error || parsed.words.some(word => !isValidNtpServer(word))) return false;
		for (const word of parsed.words) if (!servers[key].includes(word)) servers[key].push(word);
		return true;
	};
	for (let physical of output.split(/\r?\n/)) {
		// Each source file starts a fresh section context; a missing [Time] must not inherit one.
		if (/^# \/(?:etc|run|usr\/local\/lib|usr\/lib)\/systemd\/timesyncd\.conf(?:\.d\/[^/]+\.conf)?$/.test(physical)) {
			if (continuation && !apply(continuation)) return null;
			continuation = '';
			section = '';
			bomSeen = false;
			continue;
		}
		if (/^[ \t\r]*[#;]/.test(physical)) continue;
		if (!bomSeen && physical.startsWith('\uFEFF')) {
			physical = physical.slice(1);
			bomSeen = true;
		}
		const logical = continuation + physical;
		const trailing = /\\+$/.exec(logical)?.[0].length ?? 0;
		if (trailing % 2 === 1) {
			continuation = logical.slice(0, -1) + ' ';
			continue;
		}
		continuation = '';
		if (!apply(logical)) return null;
	}
	if (continuation && !apply(continuation)) return null;
	return servers;
}

export function parseTimesyncConfig(output: string): string | null {
	const servers = parseTimesyncServerLists(output);
	return servers?.NTP[0] ?? servers?.FallbackNTP[0] ?? null;
}

/** A single-server write must survive later overrides before any daemon restart. */
export async function verifyTimesyncdServer(server: string, exec: CommandRunner = run): Promise<string | null> {
	try {
		const configuration = await exec('systemd-analyze', ['--no-pager', 'cat-config', 'systemd/timesyncd.conf']);
		if (configuration.kind !== 'ok') return 'the effective systemd-timesyncd configuration could not be read';
		const servers = parseTimesyncServerLists(configuration.output);
		if (servers === null) return 'the effective systemd-timesyncd configuration could not be interpreted safely';
		if (servers.NTP.length !== 1 || servers.NTP[0] !== server) return 'the effective systemd-timesyncd NTP server list differs from the requested server; another configuration file may override it';
		return null;
	} catch {
		return 'the effective systemd-timesyncd configuration could not be read';
	}
}

/** What systemd answered about one unit: the name it prefers for it, and its `LoadState`. */
export interface UnitState {
	/** The `Id` property — the canonical name, which an alias is NOT. */
	id: string;
	load: string;
}

/**
 * Parse `systemctl show -p Id -p Names -p LoadState <units...>` into unit name -> state.
 *
 * The output is one `Key=Value` record per unit, records separated by a blank line. Each
 * record is indexed under its `Id` AND under every name in `Names`, because those are not
 * the same thing: asking about an alias answers with the aliased unit's `Id`, so a map keyed
 * on `Id` alone has no entry under the name that was asked about. The ordered provider list
 * is looked up by the names it contains, so an aliased provider read as absent — the ordering
 * skipped it and named the next daemon down, while timedated hands the clock to the alias.
 *
 * The canonical `Id` is kept in the value so the caller can compare units by identity rather
 * than by the name it happened to ask under.
 */
export function parseUnitLoadStates(output: string): Map<string, UnitState> {
	const states = new Map<string, UnitState>();
	let id: string | null = null;
	let names: string[] = [];
	let load: string | null = null;
	const flush = (): void => {
		if (id !== null && load !== null) {
			const state: UnitState = { id, load };
			for (const name of new Set([id, ...names])) states.set(name, state);
		}
		id = null;
		names = [];
		load = null;
	};
	for (const line of output.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			flush();
			continue;
		}
		const eq = trimmed.indexOf('=');
		if (eq <= 0) continue;
		const key = trimmed.slice(0, eq);
		const value = trimmed.slice(eq + 1);
		if (key === 'Id') {
			// A second Id without a blank line between: end the record that was open.
			if (id !== null) flush();
			id = value;
		} else if (key === 'Names') names = extractWords(value, true);
		else if (key === 'LoadState') load = value;
	}
	flush();
	return states;
}

/**
 * The canonical unit name behind `unit`, or `unit` itself when systemd said nothing about it.
 *
 * Comparing unit names as text is only safe once they have been through this: `vendor-ntp.service`
 * and `systemd-timesyncd.service` can be the same unit, and the whole question here is which
 * daemon owns the clock — not which of its names somebody wrote down.
 */
export function canonicalUnitName(states: Map<string, UnitState> | null, unit: string): string {
	return states?.get(unit)?.id ?? unit;
}

/**
 * Whether systemd-timedated would consider this unit a usable provider.
 *
 * `LoadState` is exactly `loaded`, which is timedated's own test — it reads the property
 * over D-Bus and skips every unit that does not answer with it. `systemctl list-unit-files`
 * was asked before, and it is not the same question: it reports a unit FILE on disk and its
 * enablement, so a unit whose file fails to parse (`bad-setting`, `error`) or is not there
 * at all was read as usable, the drop-in was written for it and timedated then picked the
 * next provider in the ordering, which never reads that file. `masked` and `not-found`
 * still fall out, since neither of them is `loaded`.
 */
export function unitIsLoaded(states: Map<string, UnitState>, unit: string): boolean {
	return states.get(unit)?.load === 'loaded';
}

/**
 * systemd units of the other NTP implementations systemd-timedated can hand the clock
 * to. `NTP=yes` only says that SOME managed service is synchronising; when one of these
 * is the one running, a timesyncd drop-in is read by nobody.
 */
export const COMPETING_NTP_UNITS: string[] = ['chronyd.service', 'chrony.service', 'ntpd.service', 'ntpsec.service', 'openntpd.service'];

/**
 * Every unit worth asking "is an NTP daemon other than timesyncd running here".
 *
 * The hardcoded five above are a floor, not the answer: timedated accepts ANY valid unit
 * name from its ordered list, so a distribution or an administrator can put a provider
 * there that is on nobody's list — and asking only about the five reported "nothing in the
 * way" while that daemon held the clock. The host's own ordering is therefore folded in,
 * minus timesyncd, which is the one daemon that is not a competitor.
 *
 * `states` is what systemd answered about those names, and it decides which of them IS
 * timesyncd: an alias for it is a different string and excluding by text alone kept the
 * alias on the list, so timesyncd running normally answered as a competing daemon and the
 * capability went false on a host that is ours to configure.
 *
 * That test applies to the hardcoded names as well, and not only to the ordering. A host
 * where `chronyd.service` is an ALIAS of timesyncd answers for it with timesyncd's own
 * `ActiveState`, so a running timesyncd was read as chrony holding the clock — safe, in that
 * nothing is written to the wrong daemon, but the server could not be configured on a host
 * that has no other NTP daemon at all.
 *
 * Every name is queried under the spelling we hold — the host's own for an entry of the
 * ordering, ours for the five above — and only JUDGED by its canonical form. `systemctl show`
 * answers for an alias just as well as for the real name, so there is nothing to gain by
 * rewriting the ordering's entries into names the host never wrote.
 */
export function competingNtpUnits(ordered: string[] | null, states: Map<string, UnitState> | null = null): string[] {
	const units = new Set<string>();
	for (const unit of [...COMPETING_NTP_UNITS, ...(ordered ?? [])]) {
		if (canonicalUnitName(states, unit) !== TIMESYNCD_UNIT) units.add(unit);
	}
	return [...units];
}

/**
 * True when `systemctl show -p ActiveState --value <units...>` reports any of them as
 * running. A unit that does not exist on the host reports `inactive`, so an absent
 * chrony is indistinguishable from a stopped one — which is the correct answer here.
 *
 * The test is systemd-timedated's own, and it is the INVERSE of the obvious one: it counts
 * a unit as active unless its state is exactly `inactive` or `failed`. Listing the states
 * that mean "running" instead left `deactivating` — a daemon on its way down that still
 * holds the clock — and every state a future systemd may add reading as "nothing in the
 * way". An unrecognised state has to fail closed, and only this direction does that.
 */
export function parseAnyUnitActive(output: string): boolean {
	return output.split(/\r?\n/).some(line => {
		const state = line.trim();
		return state.length > 0 && state !== 'inactive' && state !== 'failed';
	});
}

/**
 * Directories systemd-timedated reads its ordered NTP provider list from, most specific
 * first. A file name present in an earlier directory shadows the same name in a later
 * one; across different names the whole set is ordered lexicographically by file name,
 * which is what the numeric prefixes (`50-chronyd.list`, `80-systemd-timesync.list`) are
 * for.
 */
const NTP_UNITS_DIRS: string[] = ['/etc/systemd/ntp-units.d', '/run/systemd/ntp-units.d', '/usr/local/lib/systemd/ntp-units.d', '/usr/lib/systemd/ntp-units.d'];

/** Environment override timedated honours in place of the directories above; colon-separated. */
const NTP_SERVICES_ENV = 'SYSTEMD_TIMEDATED_NTP_SERVICES';

/** The unit whose environment decides the override — timedated's own, not ours. */
const TIMEDATED_UNIT = 'systemd-timedated.service';

/** The unit types systemd knows; a name whose suffix is not one of them is not a unit name. */
const UNIT_TYPES: string[] = ['service', 'socket', 'target', 'device', 'mount', 'automount', 'swap', 'timer', 'path', 'slice', 'scope'];

/** `UNIT_NAME_MAX` upstream, counted without the terminator. */
const UNIT_NAME_MAX = 255;

/**
 * The characters a unit name may be built from, `@` deliberately excluded — see
 * {@link isValidUnitName}.
 */
const UNIT_NAME_PREFIX_RE = /^[A-Za-z0-9:_.\\-]+$/;

/**
 * A syntactically valid PLAIN systemd unit name, which is what timedated demands.
 *
 * Every entry of the ordered list goes through `unit_name_is_valid(s, UNIT_NAME_PLAIN)`
 * upstream, and the entries that fail are not part of the ordering — so they must not be
 * part of ours either. Passing one on would also fail the whole `systemctl show` that
 * follows, and one malformed line in a vendor's `.list` file would take the provider read
 * down with it and turn the capability off on a host that is perfectly fine.
 *
 * `UNIT_NAME_PLAIN` is narrower than "looks like a unit name". It rejects instance and
 * template names — anything containing `@` — which we used to accept: such an entry could be
 * named as the first usable provider here while timedated ignores it outright and hands the
 * clock to the next daemon down, the one that never reads our drop-in. And the suffix has to
 * be a type systemd actually has: any lowercase word was accepted before, so `foo.waldo`
 * reached `systemctl show`, which fails the whole call over it.
 */
function isValidUnitName(name: string): boolean {
	if (name.length === 0 || name.length > UNIT_NAME_MAX) return false;
	const dot = name.lastIndexOf('.');
	// `e == n` upstream: a name that is nothing but a suffix is not a name.
	if (dot <= 0) return false;
	if (!UNIT_TYPES.includes(name.slice(dot + 1))) return false;
	return UNIT_NAME_PREFIX_RE.test(name.slice(0, dot));
}

/** The whitespace `extract_first_word()` separates on when nothing else is asked for. */
const WHITESPACE = ' \t\n\r';

/**
 * What {@link extractWordsChecked} read: the words up to the point it got to, and whether it
 * stopped on a syntax error rather than on the end of the value.
 *
 * Tokens alone could not carry that. `a\` is not "the word `a`" — upstream returns `-EINVAL`
 * for it and the caller has read a value systemd itself would have refused, which is not the
 * same as having read the value.
 */
export type ExtractedWords = { words: string[]; error: boolean };

/**
 * Split a systemctl value into words the way systemd's own `extract_first_word()` does.
 *
 * Splitting on whitespace is not that parser, and the difference is not cosmetic here:
 * systemd quotes and escapes what it prints, so a variable whose value is
 * `a b SYSTEMD_TIMEDATED_NTP_SERVICES=chronyd.service` arrives quoted as one word and a
 * whitespace split tears a standalone assignment out of the middle of it — an NTP override
 * the host never set, deciding which daemon we believe owns the clock.
 *
 * `unquote` is upstream's `EXTRACT_UNQUOTE`: set for environment values, which systemd
 * quotes on the way out, and clear for the provider list, which timedated parses with flags
 * `0` — there a quote is an ordinary character, and one no valid unit name may contain
 * anyway. A backslash escapes the next character in both modes, as it does upstream, so an
 * escaped separator does not split. Runs of separators are coalesced and yield no empty
 * word, which is `extract_first_word`'s default.
 *
 * The words read before a syntax error are kept, and `error` says one was hit — see
 * {@link ExtractedWords}. {@link extractWords} is the same parser for the callers that only
 * want what could be read.
 */
export function extractWordsChecked(input: string, unquote: boolean, separators: string = WHITESPACE): ExtractedWords {
	const words: string[] = [];
	let word = '';
	let started = false;
	let quote: string | null = null;
	let escaped = false;
	for (const ch of input) {
		if (escaped) {
			word += ch;
			escaped = false;
		} else if (ch === '\\') {
			escaped = true;
			started = true;
		} else if (quote !== null) {
			if (ch === quote) quote = null;
			else word += ch;
		} else if (unquote && (ch === '"' || ch === "'")) {
			quote = ch;
			started = true;
		} else if (separators.includes(ch)) {
			if (started) words.push(word);
			word = '';
			started = false;
		} else {
			word += ch;
			started = true;
		}
	}
	// A backslash with nothing behind it, and in unquoting mode a quote that is never closed,
	// are `-EINVAL` upstream: the word under construction is not a word, so it is dropped
	// rather than emitted half-written, and the caller is told the value was malformed. Both
	// can only happen at the end of the input, so there is nothing left to stop parsing.
	if (escaped || quote !== null) return { words, error: true };
	if (started) words.push(word);
	return { words, error: false };
}

/**
 * The same words, for the callers that have nothing to do with a malformed value but read
 * what there was.
 *
 * That is upstream's behaviour for the provider list: timedated logs the syntax error, keeps
 * the entries it got to, and does not fall back to the list files. For the `Names` of a unit
 * it is simply the safe direction — an alias lost to a malformed value leaves that unit ON
 * the competitor list, which refuses a write rather than permitting one. Anywhere the answer
 * would be trusted instead, use {@link extractWordsChecked} and refuse.
 */
export function extractWords(input: string, unquote: boolean, separators: string = WHITESPACE): string[] {
	return extractWordsChecked(input, unquote, separators).words;
}

/** `Key=Value` lines of a single unit's `systemctl show` output, keyed by property name. */
function parseUnitProperties(output: string): Map<string, string> {
	const props = new Map<string, string>();
	for (const line of output.split(/\r?\n/)) {
		const eq = line.indexOf('=');
		if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1));
	}
	return props;
}

/** One `NAME=value` word, or null when it is not an assignment. */
function splitAssignment(word: string): [string, string] | null {
	const eq = word.indexOf('=');
	return eq > 0 ? [word.slice(0, eq), word.slice(eq + 1)] : null;
}

/**
 * The environment systemd-timedated runs with, as `KEY=value` pairs, or null when it could
 * not be established.
 *
 * Reading `process.env` here was wrong in both directions. timedated takes
 * {@link NTP_SERVICES_ENV} from ITS OWN process: an override an administrator set through
 * `Environment=` or a drop-in on `systemd-timedated.service` is invisible to us, so we
 * would use the directory ordering while timedated used the override — write the drop-in,
 * report success, and have `set-ntp` start a daemon that never reads it. The other
 * direction is as bad: the variable set in OUR environment changes nothing about
 * timedated, and honouring it made us report an ordering the host does not have.
 *
 * A system service does NOT inherit the manager's environment. Only the names its
 * `PassEnvironment=` lists reach it, `Environment=` is applied on top of those, and
 * `UnsetEnvironment=` is applied last and can take a value away that either of the first two
 * put there. Merging the manager environment wholesale read an override to timedated that
 * timedated never sees — it would pick the first provider on disk while we configured the
 * one the variable names, and `set-ntp` would then start a daemon that never reads our
 * drop-in. Reversed, a value removed by `UnsetEnvironment=` had us honour an override that
 * is not in force.
 *
 * Both sources have to be readable — either could be the one carrying the override, and an
 * ordering derived from half the answer is a guess.
 *
 * `EnvironmentFile=` is a source we do NOT read, so a unit that has one is answered as an
 * environment we could not establish rather than as one without it. The files would have to
 * be read from the host and parsed with systemd's own rules — its quoting, its line
 * continuations, the optional `-` prefix, later files overriding earlier ones, specifiers in
 * the path — and getting any of that wrong picks the wrong provider silently, which is the
 * very failure this function exists to prevent. Ignoring the files instead is not the safe
 * side either, and the competing-daemon check is NOT a backstop for it: a file naming
 * `chronyd.service` first, with chrony installed but not yet running, is invisible to a
 * check that only asks which daemon is active — we would write the timesyncd drop-in,
 * report success, and `set-ntp` would then start chrony, which never reads it. So the
 * capability to set a server goes off here and the host is left alone.
 *
 * `systemctl show` OMITS `EnvironmentFiles=` entirely when the unit has none, rather than
 * printing it empty the way it prints `Environment=` — so an absent line is the ordinary
 * "no file" answer and only a line that is there decides anything. An unknown property name
 * is omitted just the same, which is why the name matters more than it looks: get it wrong
 * and this reads "no file" on every host in the world. Both behaviours, and the
 * `PATH (ignore_errors=yes)` shape of the value, were checked against a running systemd.
 *
 * `LoadState` is asked for because a SUCCESSFUL `systemctl show` is no evidence that the unit
 * exists: for a name nothing matches it exits 0 and prints every requested property empty
 * (checked against a running systemd, which answered `LoadState=not-found` while echoing the
 * name straight back as `Id`). Without this, a wrong unit name — a typo, or a systemd that
 * renames the service one day — would read as "timedated sets no override", we would take
 * the directory ordering as authoritative, and nothing anywhere would say we had asked about
 * a unit that is not there. Anything but `loaded` is an environment we did not read.
 */
export async function readTimedatedEnvironment(exec: CommandRunner = run): Promise<Record<string, string> | null> {
	const manager = await exec('systemctl', ['show-environment']);
	if (manager.kind !== 'ok') return null;
	const unit = await exec('systemctl', ['show', '-p', 'LoadState', '-p', 'Environment', '-p', 'EnvironmentFiles', '-p', 'PassEnvironment', '-p', 'UnsetEnvironment', TIMEDATED_UNIT]);
	if (unit.kind !== 'ok') return null;
	const props = parseUnitProperties(unit.output);
	if (props.get('LoadState') !== 'loaded') return null;
	if ((props.get('EnvironmentFiles') ?? '').trim().length > 0) return null;
	// `show-environment` prints one assignment per line; the unit properties print their
	// entries whitespace-separated on one. Both are quoted by systemd, so both are read with
	// systemd's own word parser rather than by splitting on whitespace.
	//
	// A value that parser refuses is an environment we did not read: the words after the
	// error are lost, and the override deciding the provider may be exactly one of them. Same
	// answer as a source that did not answer at all.
	let malformed = false;
	const words = (value: string): string[] => {
		const read = extractWordsChecked(value, true);
		if (read.error) malformed = true;
		return read.words;
	};
	const inherited = new Map<string, string>();
	for (const word of words(manager.output)) {
		const pair = splitAssignment(word);
		if (pair) inherited.set(pair[0], pair[1]);
	}
	const env: Record<string, string> = {};
	// Phase 1: the manager's value, but only for a name the unit asks to be passed.
	for (const name of words(props.get('PassEnvironment') ?? '')) {
		const value = inherited.get(name);
		if (value !== undefined) env[name] = value;
	}
	// Phase 2: the unit's own `Environment=`, which wins over what was passed in.
	for (const word of words(props.get('Environment') ?? '')) {
		const pair = splitAssignment(word);
		if (pair) env[pair[0]] = pair[1];
	}
	// Phase 3: `UnsetEnvironment=`. A bare name removes the variable; a `NAME=value` entry
	// removes it only when the value matches, which is systemd's own rule.
	for (const word of words(props.get('UnsetEnvironment') ?? '')) {
		const pair = splitAssignment(word);
		if (!pair) delete env[word];
		else if (env[pair[0]] === pair[1]) delete env[pair[0]];
	}
	return malformed ? null : env;
}

/**
 * The NTP providers systemd-timedated would consider, in ITS order.
 *
 * This matters because `timedatectl set-ntp true` does not start systemd-timesyncd — it
 * starts the FIRST unit in this list that exists on the host. A machine with chrony
 * installed but stopped has `50-chronyd.list` sorting ahead of `80-systemd-timesync.list`,
 * so writing a timesyncd drop-in and switching synchronisation on hands the clock to
 * chrony, which never reads that file. Checking only which daemons are currently ACTIVE
 * misses exactly that case.
 *
 * Returns null when the ordering could not be read — which is NOT the empty list. An
 * empty list is a host that ships no ordering at all and is handled by its own rule
 * ({@link canConfigureTimesyncdServer}); null is a host whose ordering exists and is
 * unknown to us, where nothing about who owns the clock may be concluded.
 *
 * `env` is timedated's environment from {@link readTimedatedEnvironment}, and null there —
 * an environment that could not be read — is itself an unknown ordering: the override it
 * might carry replaces the directories entirely.
 *
 * `dirs` is injectable so the ordering rules can be exercised off a systemd host.
 */
export async function readNtpUnitsList(env: Record<string, string> | null, dirs: string[] = NTP_UNITS_DIRS): Promise<string[] | null> {
	if (env === null) return null;
	const override = env[NTP_SERVICES_ENV];
	// timedated splits this list with `extract_first_word(&p, &word, ":", 0)`, so a colon
	// escaped with a backslash belongs to the name rather than ending it, and a plain
	// `split(':')` would cut a unit name in half there.
	if (override !== undefined) return extractWords(override, false, ':').filter(isValidUnitName);
	// Basename -> path, first directory wins: the shadowing rule every systemd drop-in
	// directory set follows.
	const files = new Map<string, string>();
	for (const dir of dirs) {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch (err) {
			// A directory that is not there is the ordinary case — hardly any host ships all
			// four. Every other error means part of the ordering stayed unread, and a partial
			// ordering is not one: the very entry that would have put chrony ahead of
			// timesyncd is the one that could be missing. Null says "cannot be determined".
			if ((err as { code?: string }).code === 'ENOENT') continue;
			return null;
		}
		for (const name of names) {
			if (name.endsWith('.list') && !files.has(name)) files.set(name, join(dir, name));
		}
	}
	const units: string[] = [];
	for (const name of [...files.keys()].sort()) {
		// Same rule for the file itself: a list that was there a moment ago and cannot be
		// read now leaves the ordering incomplete, which is not the same as empty.
		const content = await readFile(files.get(name)!, 'utf8').catch(() => null);
		if (content === null) return null;
		for (const line of content.split('\n')) {
			const unit = line.trim();
			if (unit.length === 0 || unit.startsWith('#')) continue;
			// An entry timedated would reject is not part of ITS ordering, so it must not be
			// part of ours either.
			if (isValidUnitName(unit) && !units.includes(unit)) units.push(unit);
		}
	}
	return units;
}

/**
 * The provider `timedatectl set-ntp true` would actually start: the first unit of
 * `ordered` whose `LoadState` is `loaded`. Null when none of them is.
 *
 * Answered as the CANONICAL name, not as the entry that matched. An ordering may name a
 * provider through an alias, and the caller's question is which daemon this is — an alias
 * for timesyncd compared unequal to it and had the host reported as somebody else's.
 */
export function firstUsableNtpUnit(ordered: string[], unitOutput: string | null): string | null {
	if (unitOutput === null) return null;
	const states = parseUnitLoadStates(unitOutput);
	const found = ordered.find(unit => unitIsLoaded(states, unit));
	return found === undefined ? null : canonicalUnitName(states, found);
}

/**
 * Whether writing the timesyncd drop-in would actually change the host's time source.
 *
 * Only true when timesyncd is the provider this host would use. Otherwise the drop-in is
 * read by nobody: the file lands, the API reports success, and the clock keeps coming
 * from whichever daemon timedated hands it to.
 *
 * An EMPTY `ordered` list is not a competitor — it means the host ships no provider
 * ordering at all, so `set-ntp` has nothing to hand the clock to and restarting timesyncd
 * ourselves is the whole mechanism. There the older test stands: timesyncd installed, and
 * no other NTP daemon currently running.
 *
 * A NULL `ordered` or `competingOutput` is neither of those: it is a state that could not
 * be read. Both used to resolve to "nothing in the way", which is the permissive answer to
 * a question nobody answered — the drop-in would be written and reported as saved while
 * the daemon that actually holds the clock never reads it. Unknown refuses.
 */
export function canConfigureTimesyncdServer(ordered: string[] | null, unitOutput: string | null, competingOutput: string | null): boolean {
	// Belt to the ordered list's braces: a daemon someone started outside timedated's
	// ordering owns the clock just as effectively — and one we could not ask about may be
	// running just as well as one that answered.
	if (competingOutput === null || parseAnyUnitActive(competingOutput)) return false;
	if (ordered === null) return false;
	if (ordered.length > 0) return firstUsableNtpUnit(ordered, unitOutput) === TIMESYNCD_UNIT;
	return unitOutput !== null && unitIsLoaded(parseUnitLoadStates(unitOutput), TIMESYNCD_UNIT);
}

/**
 * Content of the systemd-timesyncd drop-in pinning `server` as the NTP source.
 *
 * `NTP=` is a list setting: a drop-in is parsed after the shipped configuration, so a
 * bare assignment APPENDS to whatever the distribution already configured instead of
 * replacing it. The empty assignment first resets the list, which is what makes this
 * a pin rather than an addition.
 */
export function buildTimesyncdDropIn(server: string): string {
	return `[Time]\nNTP=\nNTP=${server}\n`;
}

/** Read the Linux (systemd-timedated) part of the status. */
export async function readLinuxStatus(): Promise<PlatformStatus> {
	const show = await tryRead('timedatectl', ['show']);
	if (show === null) {
		// ponytail: no systemd-timedated means no supported backend here. The
		// `date -s` / `/etc/localtime` symlink fallback is deliberately not
		// implemented — the hosts that lack timedatectl are containers, which have
		// no CAP_SYS_TIME and cannot set the clock at all. Add it if a non-systemd
		// bare-metal target ever appears.
		return UNREADABLE_STATUS;
	}
	const map = parseTimedatectlShow(show);
	const canNtp = parseYesNo(map['CanNTP']) ?? false;
	const timesync = canNtp ? await tryRead('timedatectl', ['show-timesync', '--all']) : null;
	// Only timesyncd's configuration file is written by us, so the capability is "would
	// this host's timedated actually use timesyncd" — a chrony host ignores the drop-in.
	// That is decided by the provider ordering timedated itself reads, checked against each
	// unit's `LoadState`, which is the property timedated selects on: `show-timesync` would
	// only answer while the daemon runs, and the UI turns synchronisation off before writing
	// a server.
	// `Names` comes along because an entry of the ordering may be an alias, and systemd
	// answers for an alias under the aliased unit's `Id` — with only `Id` asked for, the
	// name we looked the state up by was in no answer at all.
	// `--` because those names come off the host's own files and a valid unit name may begin
	// with a dash: without the separator systemctl reads it as an option instead.
	const ordered = canNtp ? await readNtpUnitsList(await readTimedatedEnvironment()) : [];
	const unit = canNtp ? await tryRead('systemctl', ['show', '-p', 'Id', '-p', 'Names', '-p', 'LoadState', '--', ...(ordered !== null && ordered.length > 0 ? ordered : [TIMESYNCD_UNIT])]) : null;
	// timedated manages several NTP implementations; a host where chrony is the active
	// one would ignore our drop-in entirely (see canConfigureTimesyncdServer). The units to
	// ask about come from the host's own ordering as well as the known names, so a provider
	// nobody hardcoded is still seen — with the aliases resolved, or timesyncd under another
	// name would be counted as a daemon competing with itself.
	const states = unit === null ? null : parseUnitLoadStates(unit);
	const competing = canNtp ? await tryRead('systemctl', ['show', '-p', 'ActiveState', '--value', '--', ...competingNtpUnits(ordered, states)]) : null;
	const configurable = canConfigureTimesyncdServer(ordered, unit, competing);
	let ntpServer = timesync === null ? null : parseTimesyncServer(timesync);
	if (ntpServer === null && configurable) {
		// show-timesync is unavailable while the service is stopped; the OS still knows file precedence.
		const configuration = await tryRead('systemd-analyze', ['--no-pager', 'cat-config', 'systemd/timesyncd.conf']);
		if (configuration !== null) ntpServer = parseTimesyncConfig(configuration);
	}
	return {
		// `timedatectl show` was read above and already carries it — no extra probe.
		timezone: map['Timezone'] ?? null,
		ntpEnabled: parseYesNo(map['NTP']),
		ntpSynchronized: parseYesNo(map['NTPSynchronized']),
		ntpServer,
		capabilities: { setClock: true, setTimezone: true, setNtpEnabled: canNtp, setNtpServer: configurable },
	};
}
