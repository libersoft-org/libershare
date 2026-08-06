<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { t, tt, translateError, withDetail } from '../../scripts/language.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { api } from '../../scripts/api.ts';
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
	let loaded = $state({ autoSync: false, ntpServer: '', timezone: '', clock: '' });

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
		status = next;
		readAt = performance.now();
		// The backend may run on a different machine (or in a different zone) than the
		// browser, so the host's wall clock is reconstructed from its own UTC offset
		// instead of the browser's local getters.
		const hostLocal = new Date(next.nowMs + next.utcOffsetMinutes * 60000);
		hours = pad(hostLocal.getUTCHours());
		minutes = pad(hostLocal.getUTCMinutes());
		seconds = pad(hostLocal.getUTCSeconds());
		autoSync = next.ntpEnabled;
		ntpServer = next.ntpServer ?? '';
		timezone = next.timezone;
		loaded = { autoSync, ntpServer, timezone, clock: `${hours}:${minutes}:${seconds}` };
	}

	// Settled, not all: a host that cannot list its timezones still has a clock and an
	// NTP state worth showing, and failing the whole screen over the picker would hide
	// them behind a bare error.
	async function load(): Promise<void> {
		const [statusResult, zonesResult] = await Promise.allSettled([api.call<SystemTimeStatus>('system.getTime'), api.call<string[]>('system.listTimezones')]);
		timezones = zonesResult.status === 'fulfilled' ? zonesResult.value : [];
		if (statusResult.status === 'fulfilled') applyStatus(statusResult.value);
		else errorMessage = translateError(statusResult.reason);
	}

	void load();

	let offTimeChanged: (() => void) | void;

	onMount(() => {
		// Keep the clock fields on the host's current time until the user types in them.
		// Filled once at load they would go stale while the page is open, and a save that
		// only changed the timezone would write back the time the page was opened at.
		const tick = setInterval(() => {
			if (!status || busy || clockEdited) return;
			const hostLocal = new Date(status.nowMs + (performance.now() - readAt) + status.utcOffsetMinutes * 60000);
			hours = pad(hostLocal.getUTCHours());
			minutes = pad(hostLocal.getUTCMinutes());
			seconds = pad(hostLocal.getUTCSeconds());
			// Move the baseline with them, or the tick itself would read as a user edit.
			loaded = { ...loaded, clock: `${hours}:${minutes}:${seconds}` };
		}, 1000);
		// Another window writing the time must not leave this form showing the old host
		// state — the backend broadcasts the fresh status after every successful write.
		offTimeChanged = api.on('system:timeChanged', (next: SystemTimeStatus) => {
			// Never over an edit in progress: re-filling the form here would throw away
			// what the user has typed without saying so. They keep their values and the
			// next save reports the conflict.
			if (!busy && !hasChanges) applyStatus(next);
		});
		// Best-effort: with the WS down the call rejects — swallow it, the event just stays unsubscribed.
		api.subscribe('system:timeChanged').catch(() => {});
		return () => clearInterval(tick);
	});

	onDestroy(() => {
		offTimeChanged?.();
		api.unsubscribe('system:timeChanged').catch(() => {});
	});

	function toggleAutoSync(): void {
		if (busy || !status?.capabilities.setNtpEnabled) return;
		autoSync = !autoSync;
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
		errorMessage = outcomeMessage(res);
		await load();
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
			if (!autoSync && loaded.autoSync && !(await apply(api.call<SystemTimeResult>('system.setNtpEnabled', { enabled: false })))) return;
			if (ntpServer.trim() !== loaded.ntpServer && !(await apply(api.call<SystemTimeResult>('system.setNtpServer', { server: ntpServer.trim() })))) return;
			if (timezone !== loaded.timezone && !(await apply(api.call<SystemTimeResult>('system.setTimezone', { timezone })))) return;
			if (clock && !(await apply(api.call<SystemTimeResult>('system.setClock', clock)))) return;
			if (autoSync && !loaded.autoSync && !(await apply(api.call<SystemTimeResult>('system.setNtpEnabled', { enabled: true })))) return;
			addNotification(tt('settings.time.saved'), 'success');
			onBack?.();
		} catch (e) {
			errorMessage = translateError(e);
		} finally {
			busy = false;
		}
	}

	// The host's own zone always belongs in the list, even when the runtime's timezone
	// database does not name it — several valid identifiers are aliases that
	// `Intl.supportedValuesOf` omits, and a value with no matching option leaves the
	// picker blank instead of showing where the host actually is.
	let selectableTimezones = $derived(status && !timezones.includes(status.timezone) ? [status.timezone, ...timezones] : timezones);
	let clockDisabled = $derived(busy || autoSync || !status?.capabilities.setClock);
	// Nothing to write means nothing to report: without this the button runs no request
	// at all and still announces the settings as saved.
	let hasChanges = $derived(autoSync !== loaded.autoSync || ntpServer.trim() !== loaded.ntpServer || timezone !== loaded.timezone || (clockEdited && !autoSync));

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
