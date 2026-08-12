<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { t, tt, translateError, withDetail } from '../../scripts/language.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { api } from '../../scripts/api.ts';
	import { connected } from '../../scripts/ws-client.ts';
	import { createStatusGate, syncSwitchIsDirty, writeFailureMessage } from '../../scripts/timeStatusSync.ts';
	import { type SystemTimeOutcome, type SystemTimeResult, type SystemTimeStatus } from '@shared';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
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
	let status = $state<SystemTimeStatus | null>(null);
	let timezones = $state<string[]>([]);
	let errorMessage = $state('');
	let busy = $state(false);
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

	function pad(value: number): string {
		return String(value).padStart(2, '0');
	}

	// When the snapshot in `status` was taken, so the displayed clock can be advanced
	// from it without asking the host again every second. Read off performance.now()
	// rather than the wall clock: the browser's own clock can be stepped (by its NTP
	// client, or by the very host change being made here) and the displayed time would
	// jump with it.
	let readAt = 0;

	/** Fill the form from a host status snapshot and remember it as the comparison baseline. */
	function applyStatus(next: SystemTimeStatus): void {
		// Whatever is adopted here is the newest state the form knows about, so every status
		// read still in flight is now answering an older question.
		statusGate.supersede();
		status = next;
		readAt = performance.now();
		// The backend may run on a different machine (or in a different zone) than the
		// browser, so the host's wall clock is reconstructed from its own UTC offset
		// instead of the browser's local getters.
		const hostLocal = new Date(next.nowMs + next.utcOffsetMinutes * 60000);
		hours = pad(hostLocal.getUTCHours());
		minutes = pad(hostLocal.getUTCMinutes());
		seconds = pad(hostLocal.getUTCSeconds());
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
	 */
	async function load(): Promise<string> {
		const current = statusGate.begin();
		const [statusResult, zonesResult] = await Promise.allSettled([api.call<SystemTimeStatus>('system.getTime'), api.call<string[]>('system.listTimezones')]);
		timezones = zonesResult.status === 'fulfilled' ? zonesResult.value : [];
		if (statusResult.status === 'rejected') return translateError(statusResult.reason);
		// A broadcast, or a later read, may have landed while this one was out. Its state is
		// the fresher one and this answer predates it — applying it anyway would rewind the
		// form to what the host looked like before the change it has already been told about.
		if (current()) applyStatus(statusResult.value);
		return '';
	}

	/** Load with nothing to preserve: whatever went wrong IS the message. */
	async function reload(): Promise<void> {
		const failure = await load();
		if (failure) errorMessage = failure;
	}

	void reload();

	let offTimeChanged: (() => void) | void;

	onMount(() => {
		// Keep the clock fields on the host's current time until the user types in them.
		// Filled once at load they would go stale while the page is open, and a save that
		// only changed the timezone would write back the time the page was opened at.
		const tick = setInterval(() => {
			if (!status || busy || clockEdited) return;
			resyncClockFields();
		}, 1000);
		// Another window writing the time must not leave this form showing the old host
		// state — the backend broadcasts the fresh status after every successful write.
		offTimeChanged = api.on('system:timeChanged', (next: SystemTimeStatus) => {
			// Never over an edit in progress: re-filling the form here would throw away
			// what the user has typed without saying so. They keep their values, and the
			// save that follows overwrites whatever the other window wrote — last write
			// wins. There is no conflict detection: the values carry no revision, so this
			// screen cannot tell "changed underneath me" from "unchanged". Detecting it
			// needs a revision on the status and a precondition on the write.
			if (!busy && !hasChanges) applyStatus(next);
		});
		// Best-effort: with the WS down the call rejects — swallow it, the event just stays unsubscribed.
		api.subscribe('system:timeChanged').catch(() => {});
		// The backend keeps subscriptions per connection, so a dropped socket takes this
		// one with it and the page would sit there silently stale for as long as it is
		// open. Re-subscribe on every reconnect and re-read what was missed while down —
		// never over an edit in progress, which is the same rule the event handler follows.
		let firstEmission = true;
		const offConnected = connected.subscribe(isConnected => {
			// The store replays its current value on subscribe; the initial subscribe above
			// has that covered.
			if (firstEmission) {
				firstEmission = false;
				return;
			}
			if (!isConnected) return;
			// Subscribe BEFORE reading, and wait for it. Fired side by side, the read can be
			// answered while the subscription is still being registered — and a change made in
			// exactly that window is broadcast to nobody and is already absent from the answer
			// that arrives, so the form sits on a state the host has left with nothing left to
			// correct it.
			void api
				.subscribe('system:timeChanged')
				.catch(() => {})
				.then(() => {
					if (!busy && !hasChanges) void reload();
				});
		});
		return () => {
			clearInterval(tick);
			offConnected();
		};
	});

	onDestroy(() => {
		offTimeChanged?.();
		api.unsubscribe('system:timeChanged').catch(() => {});
	});

	/** Put the clock fields back on the host's current time and re-baseline them. */
	function resyncClockFields(): void {
		if (!status) return;
		const hostLocal = new Date(status.nowMs + (performance.now() - readAt) + status.utcOffsetMinutes * 60000);
		hours = pad(hostLocal.getUTCHours());
		minutes = pad(hostLocal.getUTCMinutes());
		seconds = pad(hostLocal.getUTCSeconds());
		// Move the baseline with them, or the change itself would read as a user edit.
		loaded = { ...loaded, clock: `${hours}:${minutes}:${seconds}` };
	}

	function toggleAutoSync(): void {
		if (busy || !status?.capabilities.setNtpEnabled) return;
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
		errorMessage = writeFailureMessage(outcomeMessage(res), await load());
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
		if (!status || busy || !hasChanges) return;
		errorMessage = '';
		// A hand-set clock only survives with synchronisation off, so a save that leaves
		// it on discards the edit instead of writing a value the daemon overwrites
		// seconds later — which would look like the clock silently refused to change.
		const clock = clockEdited && !autoSync ? parseClock() : null;
		if (clockEdited && !autoSync && !clock) {
			errorMessage = tt('settings.time.errorInvalidInput');
			return;
		}
		busy = true;
		try {
			// Order matters: automatic synchronisation goes off before a manual clock set
			// (the OS refuses one while NTP owns the clock) and back on only at the end,
			// so a clock set in the same save is not immediately overwritten by a sync.
			if (!autoSync && syncDirty && !(await apply(api.call<SystemTimeResult>('system.setNtpEnabled', { enabled: false })))) return;
			if (ntpServer.trim() !== loaded.ntpServer && !(await apply(api.call<SystemTimeResult>('system.setNtpServer', { server: ntpServer.trim() })))) return;
			if (timezone !== loaded.timezone && !(await apply(api.call<SystemTimeResult>('system.setTimezone', { timezone })))) return;
			if (clock && !(await apply(api.call<SystemTimeResult>('system.setClock', clock)))) return;
			if (autoSync && syncDirty && !(await apply(api.call<SystemTimeResult>('system.setNtpEnabled', { enabled: true })))) return;
			addNotification(tt('settings.time.saved'), 'success');
			onBack?.();
		} catch (e) {
			// The save is up to five separate calls, so an exception here can land between
			// two of them with the earlier ones already applied on the host. What the form
			// shows is then a mixture of what was written and what was not — re-read the
			// host and say so, instead of leaving the user looking at values that are only
			// half true.
			// The partial-save warning outlives the reload. It used to be assigned first and
			// then overwritten whenever the re-read it triggers failed too — so the one thing
			// the user had to be told, that part of the save may already be on the host, was
			// replaced by a message about the read.
			errorMessage = writeFailureMessage(withDetail(tt('settings.time.errorPartial'), translateError(e)), await load());
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
	let clockDisabled = $derived(busy || autoSync || syncUnknown || !status?.capabilities.setClock);
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
		padding: 2vh;
		gap: 1vh;
		overflow-y: auto;
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		width: 1000px;
		max-width: 100%;
	}

	.clock {
		display: flex;
		gap: 1vh;
	}

	.hint {
		font-size: 2vh;
		color: var(--disabled-foreground);
	}
</style>

<div class="settings">
	<div class="container">
		{#if errorMessage}
			<Alert type="error" message={errorMessage} />
		{/if}
		{#if status && !status.supported}
			<Alert type="warning" message={$t('settings.time.unsupported')} />
		{/if}
		{#if syncUnknown}
			<Alert type="warning" message={syncUnknownLocked ? $t('settings.time.syncUnknownLocked') : $t('settings.time.syncUnknown')} />
		{/if}
		{#if status}
			<div role="group" data-mouse-activate-area={areaID}>
				<SwitchRow label={$t('settings.time.autoSync') + ':'} checked={autoSync} disabled={busy || !status.capabilities.setNtpEnabled} position={[0, 0]} onToggle={toggleAutoSync} />
			</div>
			<div role="group" data-mouse-activate-area={areaID}>
				<Input bind:value={ntpServer} label={$t('settings.time.ntpServer')} placeholder={$t('settings.time.ntpServerPlaceholder')} disabled={busy || !status.capabilities.setNtpServer} position={[0, 1]} flex />
			</div>
			<div class="clock" role="group" data-mouse-activate-area={areaID}>
				<Input bind:value={hours} label={$t('settings.time.hours')} type="number" min={0} max={23} disabled={clockDisabled} position={[0, 2]} flex />
				<Input bind:value={minutes} label={$t('settings.time.minutes')} type="number" min={0} max={59} disabled={clockDisabled} position={[1, 2]} flex />
				<Input bind:value={seconds} label={$t('settings.time.seconds')} type="number" min={0} max={59} disabled={clockDisabled} position={[2, 2]} flex />
			</div>
			{#if autoSync}
				<div class="hint">{$t('settings.time.autoSyncHint')}</div>
			{/if}
			<div role="group" data-mouse-activate-area={areaID}>
				<Select bind:value={timezone} label={$t('settings.time.timezone')} disabled={busy || !status.capabilities.setTimezone || selectableTimezones.length === 0} position={[0, 3]} flex>
					{#each selectableTimezones as zone (zone)}
						<SelectOption value={zone} label={zone} />
					{/each}
				</Select>
			</div>
		{/if}
	</div>
	<ButtonBar justify="center" basePosition={[0, 4]}>
		<Button icon="/img/save.svg" label={$t('common.save')} disabled={busy || !status || !status.supported || !hasChanges} onConfirm={saveSettings} />
		<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
	</ButtonBar>
</div>
