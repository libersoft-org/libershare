<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { t, tt, translateError, withDetail } from '../../scripts/language.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { api } from '../../scripts/api.ts';
	import { connected } from '../../scripts/ws-client.ts';
	import { NTP_PRESETS, createStatusGate, effectiveOffsetMode, formatHostClock, formatHostDate, timeStatusChanged, loadFailureMessage, loadMayApply, planTimeChanges, syncSwitchIsDirty, writeFailureMessage } from '../../scripts/timeStatusSync.ts';
	import { type SystemTimeChanges, type SystemTimeOutcome, type SystemTimeResult, type SystemTimeStatus } from '@shared';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Icon from '../../components/Icon/Icon.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import Input from '../../components/Input/Input.svelte';
	import Select from '../../components/Input/Select.svelte';
	import SelectOption from '../../components/Input/SelectOption.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();
	/**
	 * A request the backend accepts and never answers leaves this form busy forever: the
	 * client only arms a timer when one is asked for, and while `busy` the screen ignores
	 * broadcasts and disables its own Reload — so nothing else can free it either. A
	 * dropped socket rejects the pending call, but a HEALTHY socket with no reply does not.
	 *
	 * A read is a handful of OS probes and is generously bounded. A save is not one
	 * command: switching Windows Time off alone waits up to 15 s for the service to
	 * actually stop, and a full save runs that plus a server write, a timezone change and
	 * a clock set, each with its own child-process timeout. The limit has to clear the
	 * whole sequence, or a save that is merely slow gets reported as unfinished.
	 *
	 * Timing out is NOT "it did not happen": the write may well have been applied. It is
	 * therefore reported through the same path as a transport failure — the partial-save
	 * warning plus a re-read — and never retried. Repeating a clock write would step the
	 * host's time a second time.
	 */
	const READ_TIMEOUT_MS = 30000;
	const SAVE_TIMEOUT_MS = 120000;
	let status = $state<SystemTimeStatus | null>(null);
	let timezones = $state<string[]>([]);
	let errorMessage = $state('');
	let busy = $state(false);
	let loading = $state(true);
	let liveUpdates = $state(false);
	let stale = $state(false);
	let successMessage = $state('');
	let displayClock = $state('');
	let displayDate = $state('');
	let zonesUnavailable = $state(false);
	let destroyed = false;
	let subscriptionGeneration = 0;
	// Editable copies of the host state
	let autoSync = $state(false);
	let ntpServer = $state('');
	let timezone = $state('');
	let hours = $state('');
	let minutes = $state('');
	let seconds = $state('');
	// What the host reported when the form was last filled. Only fields the user
	// actually changed get written — otherwise saving a timezone change alone would
	// also rewind the clock to whatever it was when the page opened.
	let loaded = $state<{ autoSync: boolean; syncReported: boolean | null; ntpServer: string; timezone: string; clock: string }>({ autoSync: false, syncReported: false, ntpServer: '', timezone: '', clock: '' });
	// Set once the user has deliberately worked the synchronisation switch. It is the only
	// thing that can make that switch dirty on a host that would not say what its sync
	// state is — see syncSwitchIsDirty.
	let autoSyncTouched = $state(false);
	// Decides which of several in-flight status answers is allowed to fill the form.
	const statusGate = createStatusGate();
	const timezoneGate = createStatusGate();
	let foregroundRead: (() => boolean) | null = null;

	// When the snapshot in `status` was taken, so the displayed clock can be advanced
	// from it without asking the host again every second. Read off performance.now()
	// rather than the wall clock: the browser's own clock can be stepped (by its NTP
	// client, or by the very host change being made here) and the displayed time would
	// jump with it.
	let readAt = 0;
	// Whether the named zone's rules may be trusted for this snapshot, or the host's own
	// number has to be used because the browser's timezone database disagrees with it.
	let offsetMode: 'zone' | 'fixed' = 'zone';

	/** Fill the form from a host status snapshot and remember it as the comparison baseline. */
	function applyStatus(next: SystemTimeStatus): void {
		// Whatever is adopted here is the newest state the form knows about, so every status
		// read still in flight is now answering an older question.
		statusGate.supersede();
		status = next;
		stale = false;
		loading = false;
		readAt = performance.now();
		offsetMode = effectiveOffsetMode(next);
		// The backend may run on a different machine (or in a different zone) than the
		// browser, so the host's wall clock is reconstructed from its own UTC offset
		// instead of the browser's local getters.
		({ hours, minutes, seconds } = formatHostClock(next.nowMs, next.timezone, next.utcOffsetMinutes, offsetMode));
		displayClock = `${hours}:${minutes}:${seconds}`;
		displayDate = formatHostDate(next.nowMs, next.timezone, next.utcOffsetMinutes, offsetMode);
		// An unreadable sync state shows the switch off, but `syncUnknown` keeps the clock
		// locked: the baseline matches, so merely opening the page never writes anything.
		autoSync = next.ntpEnabled ?? false;
		ntpServer = next.ntpServer ?? '';
		timezone = next.timezone;
		// `syncReported` keeps the host's answer including the null one: the switch's own
		// baseline had to flatten that to false to have something to show.
		autoSyncTouched = false;
		loaded = { autoSync, syncReported: next.ntpEnabled, ntpServer, timezone, clock: `${hours}:${minutes}:${seconds}` };
	}

	/**
	 * Re-fill the form from the host. RETURNS the reason the status could not be read
	 * rather than showing it: every caller but the first already has something to say, and
	 * a reload triggered BY a failed save used to overwrite that message with its own —
	 * so a save that was refused, or one that stopped half-way, ended up reported as
	 * nothing worse than "could not read the time". The caller decides which survives.
	 *
	 * Settled, not all: a host that cannot list its timezones still has a clock and an
	 * NTP state worth showing, and failing the whole screen over the picker would hide
	 * them behind a bare error.
	 *
	 * `background` marks a read nobody asked for — the reconnect catch-up. Those may only
	 * fill the form while it is idle and clean, and that is decided when the ANSWER lands
	 * (see loadMayApply). A foreground read is the re-read after a failed write, where
	 * resetting the form is exactly what is wanted.
	 *
	 * The same guard covers the reason it returns. An answer that may no longer fill the form
	 * may not overwrite what the form says either — see loadFailureMessage.
	 */
	async function load(background = false): Promise<string> {
		const current = statusGate.begin();
		if (!background) foregroundRead = current;
		const currentTimezones = timezoneGate.begin();
		loading = true;
		const [statusResult, zonesResult] = await Promise.allSettled([api.call<SystemTimeStatus>('system.getTime', {}, READ_TIMEOUT_MS), api.call<string[]>('system.listTimezones', {}, READ_TIMEOUT_MS)]);
		if (foregroundRead === current) foregroundRead = null;
		// A broadcast, or a later read, may have landed while this one was out. Its state is
		// the fresher one and this answer predates it — applying it anyway would rewind the
		// form to what the host looked like before the change it has already been told about.
		const mayApply = loadMayApply({ fresh: current(), background, busy, dirty: hasChanges });
		if (current()) {
			loading = false;
			if (background && !busy && hasChanges) stale = true;
		}
		// Heartbeats supersede clock snapshots, not the independently requested timezone catalog.
		// A newer catalog request still invalidates an older reply, including a failed one.
		if (loadMayApply({ fresh: currentTimezones(), background, busy, dirty: hasChanges })) {
			timezones = zonesResult.status === 'fulfilled' ? zonesResult.value : [];
			zonesUnavailable = zonesResult.status === 'rejected';
		}
		if (statusResult.status === 'rejected') return loadFailureMessage(translateError(statusResult.reason), mayApply);
		if (mayApply) applyStatus(statusResult.value);
		return '';
	}

	/** Load with nothing to preserve: whatever went wrong IS the message. */
	async function reload(background = false): Promise<void> {
		const failure = await load(background);
		if (failure) errorMessage = failure;
	}

	let offTimeChanged: (() => void) | void;

	async function refresh(background = false): Promise<void> {
		const generation = ++subscriptionGeneration;
		const current = (): boolean => generation === subscriptionGeneration && !destroyed;
		if (!background) loading = true;
		try {
			// Bounded like the calls below. `api.subscribe` takes no limit of its own, and an
			// unanswered one held the screen on its spinner with no way out. Losing the race
			// lands in the same place a refused subscription does — live updates off, which is
			// a state the screen already shows and Reload can still retry from.
			await Promise.race([api.subscribe('system:timeChanged'), new Promise((_, reject) => setTimeout(() => reject(new Error('subscription timed out')), READ_TIMEOUT_MS))]);
			if (!current() || destroyed) return;
			liveUpdates = true;
		} catch {
			if (!current() || destroyed) return;
			liveUpdates = false;
		}
		if (background && busy) return;
		if (background && hasChanges) {
			stale = true;
			loading = false;
			return;
		}
		await reload(background);
	}

	function clearFeedback(): void {
		errorMessage = '';
		successMessage = '';
	}

	function selectServer(server: string): void {
		if (busy || loading || stale || !liveUpdates || !status?.capabilities.setNtpServer) return;
		ntpServer = server;
		clearFeedback();
	}

	async function reloadForm(): Promise<void> {
		if (busy || loading) return;
		clearFeedback();
		await refresh();
	}

	onMount(() => {
		const ticker = setInterval(() => {
			if (!status) return;
			const nowMs = status.nowMs + performance.now() - readAt;
			const clock = formatHostClock(nowMs, status.timezone, status.utcOffsetMinutes, offsetMode);
			displayClock = `${clock.hours}:${clock.minutes}:${clock.seconds}`;
			displayDate = formatHostDate(nowMs, status.timezone, status.utcOffsetMinutes, offsetMode);
			if (!busy && !stale && !clockEdited) resyncClockFields();
		}, 1000);
		offTimeChanged = api.on('system:timeChanged', (next: SystemTimeStatus) => {
			if (busy || destroyed) return;
			// A fresh event can fulfill a requested reload, but must not discard later edits.
			if (foregroundRead?.()) {
				foregroundRead = null;
				applyStatus(next);
				return;
			}
			if (!status || (!hasChanges && !stale)) {
				applyStatus(next);
				return;
			}
			const receivedAt = performance.now();
			const keepClockEdit = clockEdited;
			if (status && timeStatusChanged(status, next, receivedAt - readAt)) stale = true;
			statusGate.supersede();
			loading = false;
			status = next;
			readAt = receivedAt;
			offsetMode = effectiveOffsetMode(next);
			const clock = formatHostClock(next.nowMs, next.timezone, next.utcOffsetMinutes, offsetMode);
			displayClock = `${clock.hours}:${clock.minutes}:${clock.seconds}`;
			displayDate = formatHostDate(next.nowMs, next.timezone, next.utcOffsetMinutes, offsetMode);
			if (!keepClockEdit && !stale) resyncClockFields();
		});
		void refresh();
		let firstEmission = true;
		const offConnected = connected.subscribe(isConnected => {
			if (firstEmission) {
				firstEmission = false;
				return;
			}
			if (!isConnected) {
				liveUpdates = false;
				foregroundRead = null;
				subscriptionGeneration++;
				statusGate.supersede();
				timezoneGate.supersede();
				loading = false;
				if (!busy && hasChanges) stale = true;
				return;
			}
			void refresh(true);
		});
		return () => {
			clearInterval(ticker);
			offConnected();
		};
	});

	onDestroy(() => {
		destroyed = true;
		foregroundRead = null;
		subscriptionGeneration++;
		statusGate.supersede();
		timezoneGate.supersede();
		offTimeChanged?.();
		api.unsubscribe('system:timeChanged').catch(() => {});
	});

	/** Put the clock fields back on the host's current time and re-baseline them. */
	function resyncClockFields(): void {
		if (!status) return;
		({ hours, minutes, seconds } = formatHostClock(status.nowMs + (performance.now() - readAt), status.timezone, status.utcOffsetMinutes, offsetMode));
		// Move the baseline with them, or the change itself would read as a user edit.
		loaded = { ...loaded, clock: `${hours}:${minutes}:${seconds}` };
	}

	function toggleAutoSync(): void {
		if (busy || loading || stale || !liveUpdates || !status?.capabilities.setNtpEnabled) return;
		clearFeedback();
		// A hand-set clock cannot survive automatic synchronisation, so switching it on
		// gives up the edit. Do that visibly — put the live time back and say so — rather
		// than leaving the typed value on screen for the save to quietly ignore.
		if (!autoSync && clockEdited) {
			resyncClockFields();
			addNotification(tt('settings.time.clockEditDiscarded'), 'info');
		}
		autoSync = !autoSync;
		autoSyncTouched = true;
	}

	/** Localized reason a write was refused, with the OS text appended when there is one. */
	function outcomeMessage(res: SystemTimeResult): string {
		const keys: Record<SystemTimeOutcome, string> = {
			ok: 'settings.time.errorGeneric',
			'permission-denied': 'settings.time.errorPermissionDenied',
			unsupported: 'settings.time.errorUnsupported',
			'auto-sync-enabled': 'settings.time.errorAutoSyncEnabled',
			'invalid-input': 'settings.time.errorInvalidInput',
			stale: 'settings.time.changedOutside',
			error: 'settings.time.errorGeneric',
		};
		return withDetail(tt(keys[res.outcome]), res.message);
	}

	/**
	 * Run one write. On refusal the reason is shown and the form is re-filled from the
	 * host, so a partially applied save never leaves the user editing stale values.
	 */
	async function apply(write: Promise<SystemTimeResult>): Promise<boolean> {
		const res = await write;
		if (res.success) return true;
		// The refusal is the news; a re-read that also failed is a detail appended to it,
		// never a replacement. Losing the refusal here left the user with a message about
		// reading the time and no idea why their save had not gone through.
		const reason = res.changed || res.stateMayHaveChanged ? withDetail(tt('settings.time.errorPartial'), outcomeMessage(res)) : outcomeMessage(res);
		const failure = await load();
		if (failure) stale = true;
		errorMessage = writeFailureMessage(reason, failure);
		return false;
	}

	let clockEdited = $derived(`${hours}:${minutes}:${seconds}` !== loaded.clock);

	/** Parse the three clock fields, or null when any of them is not a valid value. */
	function parseClock(): { hours: number; minutes: number; seconds: number } | null {
		// A number input reports a blank or unparseable entry as an empty string, and
		// Number('') is 0 — without this guard a cleared field would silently set that
		// part of the clock to zero instead of being reported as invalid.
		const raw = [hours, minutes, seconds].map(v => v.trim());
		if (raw.some(v => v === '')) return null;
		const parts = raw.map(Number);
		if (parts.some(v => !Number.isInteger(v))) return null;
		const [h, m, s] = parts as [number, number, number];
		if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) return null;
		return { hours: h, minutes: m, seconds: s };
	}

	async function saveSettings(): Promise<void> {
		if (!status?.supported || busy || loading || stale || !liveUpdates || !hasChanges) return;
		clearFeedback();
		// A hand-set clock only survives with synchronisation off, so a save that leaves
		// it on discards the edit instead of writing a value the daemon overwrites
		// seconds later — which would look like the clock silently refused to change.
		const clock = clockEdited && !autoSync ? parseClock() : null;
		if (clockEdited && !autoSync && !clock) {
			errorMessage = tt('settings.time.errorInvalidInput');
			return;
		}
		// Snapshot every changed value before the request. The backend applies the snapshot
		// under one lock, so another client cannot interleave its own save between fields.
		const plan = { autoSync, syncDirty, ntpServer: ntpServer.trim(), timezone, clock, loaded: { ntpServer: loaded.ntpServer, timezone: loaded.timezone, utcOffsetMinutes: status.utcOffsetMinutes } };
		const changes: SystemTimeChanges = planTimeChanges(plan);
		busy = true;
		try {
			if (!(await apply(api.call<SystemTimeResult>('system.applyTimeSettings', changes, SAVE_TIMEOUT_MS)))) return;
			successMessage = tt('settings.time.saved');
			const failure = await load();
			if (failure) {
				stale = true;
				errorMessage = withDetail(tt('settings.time.savedReadFailed'), failure);
			}
		} catch (e) {
			// Transport failure does not prove the host applied nothing. Re-read it and keep
			// the partial-save warning even if that read fails too.
			const failure = await load();
			if (failure) stale = true;
			errorMessage = writeFailureMessage(withDetail(tt('settings.time.errorPartial'), translateError(e)), failure);
		} finally {
			busy = false;
		}
	}

	// The host's own zone always belongs in the list, even when the runtime's timezone
	// database does not name it — several valid identifiers are aliases that
	// `Intl.supportedValuesOf` omits, and a value with no matching option leaves the
	// picker blank instead of showing where the host actually is.
	let selectableTimezones = $derived(status && !timezones.includes(status.timezone) ? [status.timezone, ...timezones] : timezones);
	// The host could not say whether something else owns the clock. Setting it by hand
	// would be accepted and then quietly stepped back by the daemon, so the fields stay
	// locked until the user resolves the state by switching synchronisation either way.
	let syncUnknown = $derived(status !== null && status.supported && status.ntpEnabled === null);
	// The advice to switch synchronisation on or off only works while that switch is
	// usable. When the host will not let this application touch its time source either,
	// the two messages together are a dead end — nothing on this screen can resolve the
	// state, so say where it can be resolved instead of asking for the impossible.
	let syncUnknownLocked = $derived(syncUnknown && !status?.capabilities.setNtpEnabled);
	let formDisabled = $derived(busy || loading || stale || !liveUpdates || !status?.supported);
	let clockDisabled = $derived(formDisabled || autoSync || syncUnknown || !status?.capabilities.setClock);
	// Nothing to write means nothing to report: without this the button runs no request
	// at all and still announces the settings as saved.
	let syncDirty = $derived(syncSwitchIsDirty(autoSync, loaded.syncReported, autoSyncTouched));
	let hasChanges = $derived(syncDirty || ntpServer.trim() !== loaded.ntpServer || timezone !== loaded.timezone || (clockEdited && !autoSync));

	createNavArea(() => ({ areaID, position, onBack, activate: true }));
</script>

<style>
	.settings {
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		padding: 2vh 2vw;
		gap: 1.5vh;
		overflow-y: auto;
		box-sizing: border-box;
		color: var(--secondary-foreground);
	}
	.container {
		display: flex;
		flex-direction: column;
		width: min(100%, 820px);
		gap: 1.4vh;
		min-width: 0;
	}
	h2,
	h3,
	p,
	dl {
		margin: 0;
	}
	h2 {
		font-size: clamp(20px, 2.7vh, 28px);
		color: var(--primary-foreground);
	}
	h3 {
		font-size: clamp(16px, 2vh, 21px);
	}
	.heading,
	.pending {
		display: flex;
		gap: 1.2vh;
		align-items: center;
	}
	.hint {
		font-size: clamp(13px, 1.65vh, 17px);
		line-height: 1.45;
		color: var(--secondary-foreground);
		opacity: 0.85;
	}
	.snapshot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 1.5vh 3vh;
		background: var(--secondary-background);
		padding: 1.6vh;
		border-radius: 1vh;
	}
	.host-clock {
		font-size: clamp(28px, 4.4vh, 46px);
		font-variant-numeric: tabular-nums;
		line-height: 1.2;
	}
	.host-date {
		font-size: clamp(14px, 1.8vh, 18px);
		font-variant-numeric: tabular-nums;
	}
	.zone {
		font-size: clamp(13px, 1.7vh, 18px);
		margin-top: 0.4vh;
	}
	.sync-status {
		display: flex;
		flex-direction: column;
		gap: 0.7vh;
		font-size: clamp(13px, 1.7vh, 18px);
	}
	.sync-status dt {
		color: var(--disabled-foreground);
		font-size: clamp(12px, 1.5vh, 16px);
	}
	.sync-status dd {
		margin: 0;
	}
	.section {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		padding-top: 1.4vh;
		border-top: 1px solid var(--secondary-softer-background);
	}
	.clock {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1vh;
	}
	.container :global(.input-field),
	.container :global(.select-field) {
		min-width: 0;
	}
	.container :global(.label) {
		color: var(--secondary-foreground);
		font-size: clamp(13px, 1.7vh, 18px);
	}
	.container :global(.alert) {
		font-size: clamp(13px, 1.65vh, 17px);
		padding: clamp(10px, 1.4vh, 16px);
	}
	.container :global(.switch) {
		min-width: 72px;
		width: 72px;
		min-height: 42px;
		height: 42px;
	}
	.container :global(.slider) {
		border-width: 3px;
		border-radius: 21px;
	}
	.container :global(.slider:before) {
		width: 30px;
		height: 30px;
		left: 3px;
		bottom: 3px;
	}
	.container :global(.slider.checked:before) {
		transform: translateX(30px);
	}
	.container :global(input),
	.container :global(select) {
		min-width: 0;
		width: 100%;
		box-sizing: border-box;
		color: var(--secondary-foreground);
		background-color: var(--secondary-background);
	}
	.container :global(.input-field.disabled input),
	.container :global(.select-field.disabled select) {
		color: var(--disabled-foreground);
		background-color: var(--secondary-hard-background);
	}
	.settings :global(.button),
	.settings :global(.button.selected),
	.settings :global(.button:hover) {
		transform: none;
		box-shadow: none;
	}
	.presets :global(.button) {
		flex: 1;
		min-width: 0;
		text-align: left;
		justify-content: flex-start;
		white-space: normal;
		opacity: 1;
	}
	.presets :global(.button.disabled) {
		opacity: 0.6;
	}
	.preset-copy {
		display: flex;
		flex-direction: column;
		gap: 0.2vh;
	}
	.preset-copy strong {
		font-size: clamp(14px, 1.8vh, 19px);
	}
	.preset-copy span {
		font-size: clamp(12px, 1.5vh, 16px);
		font-weight: normal;
	}
	.pending {
		padding: 1.3vh;
		background: var(--secondary-background);
		border-radius: 1vh;
		font-size: clamp(14px, 1.8vh, 19px);
	}
	.spinner {
		width: 16px;
		height: 16px;
		border: 2px solid var(--secondary-softer-background);
		border-top-color: var(--primary-foreground);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
		flex-shrink: 0;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation: none;
		}
	}
	@media (max-width: 540px) {
		.settings {
			padding: 1.5vh 3vw;
		}
		.presets :global(.button-bar) {
			flex-direction: column !important;
		}
		.snapshot {
			align-items: flex-start;
		}
	}
</style>

<div class="settings">
	<div class="container" aria-busy={loading || busy}>
		<header class="heading">
			<Icon img="/img/time.svg" size="3vh" colorVariable="--primary-foreground" />
			<h2>{$t('settings.time.title')}</h2>
		</header>
		{#if loading}<div class="pending" role="status"><span class="spinner" aria-hidden="true"></span>{$t('settings.time.loading')}</div>{/if}
		{#if busy}<div class="pending" role="status" aria-live="polite"><span class="spinner" aria-hidden="true"></span>{$t('settings.time.saving')}</div>{/if}
		{#if errorMessage}<div class="error-message" role="alert"><Alert type="error" message={errorMessage} /></div>{/if}
		{#if successMessage}<div class="success-message" role="status"><Alert type="info" message={successMessage} /></div>{/if}
		{#if stale}<Alert type="warning" message={$t('settings.time.changedOutside')} />{/if}
		{#if status && !liveUpdates}<Alert type="warning" message={$t('settings.time.updatesUnavailable')} />{/if}
		{#if status && !status.supported}<Alert type="warning" message={$t('settings.time.unsupported')} />{/if}
		{#if syncUnknown}<Alert type="warning" message={syncUnknownLocked ? $t('settings.time.syncUnknownLocked') : $t('settings.time.syncUnknown')} />{/if}
		{#if status}
			<section class="snapshot" aria-label={$t('settings.time.currentTime')}>
				<div>
					<div class="hint">{$t(stale || !liveUpdates ? 'settings.time.lastKnownTime' : 'settings.time.currentTime')}</div>
					<div class="host-clock">{displayClock}</div>
					<div class="host-date">{displayDate}</div>
					<div class="zone">{status.timezone}</div>
				</div>
				<dl class="sync-status">
					<div>
						<dt>{$t('settings.time.autoSync')}</dt>
						<dd data-time-sync-enabled>{$t(status.ntpEnabled === null ? 'settings.time.unknown' : status.ntpEnabled ? 'settings.time.enabled' : 'settings.time.disabled')}</dd>
					</div>
					<div>
						<dt>{$t('settings.time.syncResult')}</dt>
						<dd data-time-sync-result>{$t(status.ntpSynchronized === null ? 'settings.time.syncUnreported' : status.ntpSynchronized ? 'settings.time.synchronized' : 'settings.time.notSynchronized')}</dd>
					</div>
				</dl>
			</section>
			{#if !Object.values(status.capabilities).some(Boolean)}<p class="hint">{$t('settings.time.readOnly')}</p>{/if}
			<section class="section" aria-label={$t('settings.time.autoSync')}>
				<div role="group" data-mouse-activate-area={areaID}>
					<SwitchRow label={$t('settings.time.autoSync')} checked={autoSync} icon="/img/time.svg" padding="1.2vh 1.5vh" disabled={formDisabled || !status.capabilities.setNtpEnabled} position={[0, 0]} onToggle={toggleAutoSync}>
						<p class="hint">{$t('settings.time.ntpHint')}</p>
					</SwitchRow>
				</div>
				<div role="group" data-mouse-activate-area={areaID}>
					<Input bind:value={ntpServer} onchange={clearFeedback} label={$t('settings.time.ntpServer')} placeholder={NTP_PRESETS[0]} disabled={formDisabled || !status.capabilities.setNtpServer} position={[0, 1]} fontSize="clamp(14px, 1.8vh, 18px)" padding="0.9vh 1.2vh" flex />
				</div>
				{#if !ntpServer}<p class="hint">{$t('settings.time.serverUnconfigured')}</p>{/if}
				<div class="presets">
					<ButtonBar basePosition={[0, 2]} gap="1vh">
						{#each NTP_PRESETS as server, index}
							<Button label={server} icon="/img/network.svg" active={ntpServer.trim() === server} position={[index, 2]} padding="1vh 1.4vh" disabled={formDisabled || !status.capabilities.setNtpServer} onConfirm={() => selectServer(server)}>
								<div class="preset-copy"><strong>{server}</strong><span>{$t(index === 0 ? 'settings.time.presetRecommended' : 'settings.time.presetAlternative')}</span></div>
							</Button>
						{/each}
					</ButtonBar>
				</div>
			</section>
			<section class="section" aria-label={$t('settings.time.timezone')}>
				<div role="group" data-mouse-activate-area={areaID}>
					<Select bind:value={timezone} onchange={clearFeedback} label={$t('settings.time.timezone')} disabled={formDisabled || !status.capabilities.setTimezone || selectableTimezones.length === 0} position={[0, 3]} fontSize="clamp(14px, 1.8vh, 18px)" padding="0.9vh 1.2vh" flex>
						{#each selectableTimezones as zone (zone)}<SelectOption value={zone} label={zone} />{/each}
					</Select>
				</div>
				{#if zonesUnavailable}<p class="hint">{$t('settings.time.zonesUnavailable')}</p>{/if}
			</section>
			<section class="section" aria-label={$t('settings.time.manualTime')}>
				<h3>{$t('settings.time.manualTime')}</h3>
				<div class="clock" role="group" data-mouse-activate-area={areaID}>
					<Input bind:value={hours} onchange={clearFeedback} label={$t('settings.time.hours')} type="number" min={0} max={23} disabled={clockDisabled} position={[0, 4]} fontSize="clamp(14px, 1.8vh, 18px)" padding="0.9vh 1.2vh" flex />
					<Input bind:value={minutes} onchange={clearFeedback} label={$t('settings.time.minutes')} type="number" min={0} max={59} disabled={clockDisabled} position={[1, 4]} fontSize="clamp(14px, 1.8vh, 18px)" padding="0.9vh 1.2vh" flex />
					<Input bind:value={seconds} onchange={clearFeedback} label={$t('settings.time.seconds')} type="number" min={0} max={59} disabled={clockDisabled} position={[2, 4]} fontSize="clamp(14px, 1.8vh, 18px)" padding="0.9vh 1.2vh" flex />
				</div>
				{#if autoSync}<p class="hint">{$t('settings.time.autoSyncHint')}</p>{/if}
			</section>
		{/if}
	</div>
	<ButtonBar justify="center" basePosition={[0, 5]} gap="1vh">
		<Button icon="/img/save.svg" label={busy ? $t('settings.time.saving') : $t('common.save')} position={[0, 5]} width="auto" fontSize="clamp(14px, 1.8vh, 18px)" padding="1vh 1.5vh" disabled={formDisabled || !status || !hasChanges} onConfirm={saveSettings} />
		<Button icon="/img/time.svg" label={$t('settings.time.reload')} position={[1, 5]} width="auto" fontSize="clamp(14px, 1.8vh, 18px)" padding="1vh 1.5vh" disabled={busy || loading} onConfirm={reloadForm} />
		<Button icon="/img/back.svg" label={$t('common.back')} position={[2, 5]} width="auto" fontSize="clamp(14px, 1.8vh, 18px)" padding="1vh 1.5vh" onConfirm={onBack} />
	</ButtonBar>
</div>
