<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea, type NavPos } from '../../scripts/navArea.svelte.ts';
	import { autoStartOnBoot, showInTray, minimizeToTray, defaultMinifyJSON, defaultCompress, notificationTimeout, setAutoStartOnBoot, setShowInTray, setMinimizeToTray, setDefaultMinifyJSON, setDefaultCompress, setNotificationTimeout } from '../../scripts/settings.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();
	// Local state
	let autoStart = $state($autoStartOnBoot);
	let trayVisible = $state($showInTray);
	let trayMinimize = $state($minimizeToTray);
	let minifyJSON = $state($defaultMinifyJSON);
	let compress = $state($defaultCompress);
	let timeout = $state($notificationTimeout.toString());

	function toggleAutoStart(): void {
		autoStart = !autoStart;
	}

	function toggleShowInTray(): void {
		trayVisible = !trayVisible;
		if (!trayVisible) trayMinimize = false;
	}

	function toggleMinimizeToTray(): void {
		trayMinimize = !trayMinimize;
	}

	function toggleMinifyJSON(): void {
		minifyJSON = !minifyJSON;
	}

	function toggleCompress(): void {
		compress = !compress;
	}

	function saveSettings(): void {
		setAutoStartOnBoot(autoStart);
		setShowInTray(trayVisible);
		setMinimizeToTray(trayMinimize);
		setDefaultMinifyJSON(minifyJSON);
		setDefaultCompress(compress);
		setNotificationTimeout(parseInt(timeout) || 0);
		timeout = $notificationTimeout.toString();
		onBack?.();
	}

	// Reactive positions accounting for hidden minimizeToTray row
	let minifyPos = $derived<NavPos>([0, trayVisible ? 3 : 2]);
	let compressPos = $derived<NavPos>([0, trayVisible ? 4 : 3]);
	let timeoutPos = $derived<NavPos>([0, trayVisible ? 5 : 4]);
	let buttonsY = $derived(trayVisible ? 6 : 5);

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
</style>

<div class="settings">
	<div class="container">
		<div
			role="group"
			data-mouse-activate-area={areaID}
		>
			<SwitchRow label={$t('settings.system.autoStartOnBoot') + ':'} checked={autoStart} position={[0, 0]} onToggle={toggleAutoStart} />
		</div>
		<div
			role="group"
			data-mouse-activate-area={areaID}
		>
			<SwitchRow label={$t('settings.system.showInTray') + ':'} checked={trayVisible} position={[0, 1]} onToggle={toggleShowInTray} />
		</div>
		{#if trayVisible}
			<div
				role="group"
				data-mouse-activate-area={areaID}
			>
				<SwitchRow label={$t('settings.system.minimizeToTray') + ':'} checked={trayMinimize} position={[0, 2]} onToggle={toggleMinimizeToTray} />
			</div>
		{/if}
		<div
			role="group"
			data-mouse-activate-area={areaID}
		>
			<SwitchRow label={$t('settings.system.defaultMinifyJSON') + ':'} checked={minifyJSON} position={minifyPos} onToggle={toggleMinifyJSON} />
		</div>
		<div
			role="group"
			data-mouse-activate-area={areaID}
		>
			<SwitchRow label={$t('settings.system.defaultCompress') + ':'} checked={compress} position={compressPos} onToggle={toggleCompress} />
		</div>
		<div
			role="group"
			data-mouse-activate-area={areaID}
		>
			<Input bind:value={timeout} label={$t('settings.system.notificationTimeout')} type="number" position={timeoutPos} flex />
		</div>
	</div>
	<ButtonBar justify="center">
		<Button icon="/img/save.svg" label={$t('common.save')} position={[0, buttonsY]} onConfirm={saveSettings} />
		<Button icon="/img/back.svg" label={$t('common.back')} position={[1, buttonsY]} onConfirm={onBack} />
	</ButtonBar>
</div>
