<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea, type NavPos } from '../../scripts/navArea.svelte.ts';
	import { programMode, autoStartOnBoot, showInTray, minimizeToTray, defaultMinifyJSON, defaultCompress, defaultCompressionAlgorithm, notificationTimeout, setProgramMode, setAutoStartOnBoot, setShowInTray, setMinimizeToTray, setDefaultMinifyJSON, setDefaultCompress, setDefaultCompressionAlgorithm, setNotificationTimeout, type ProgramMode } from '../../scripts/settings.ts';
	import { type CompressionAlgorithm } from '@shared';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	import CompressionAlgorithmRow from '../../components/Export/CompressionAlgorithmRow.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();
	// Local state
	let mode = $state<ProgramMode>($programMode);
	// Same switch every other row on this page uses. A native <select> was wrong here:
	// its dropdown is painted by the OS, so it ignores the app's styling entirely.
	function toggleMode(): void {
		mode = mode === 'system' ? 'app' : 'system';
	}
	let autoStart = $state($autoStartOnBoot);
	let trayVisible = $state($showInTray);
	let trayMinimize = $state($minimizeToTray);
	let minifyJSON = $state($defaultMinifyJSON);
	let compress = $state($defaultCompress);
	let compressionAlgorithm = $state<CompressionAlgorithm>($defaultCompressionAlgorithm);
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
		setProgramMode(mode);
		setAutoStartOnBoot(autoStart);
		setShowInTray(trayVisible);
		setMinimizeToTray(trayMinimize);
		setDefaultMinifyJSON(minifyJSON);
		setDefaultCompress(compress);
		setDefaultCompressionAlgorithm(compressionAlgorithm);
		setNotificationTimeout(parseInt(timeout) || 0);
		timeout = $notificationTimeout.toString();
		onBack?.();
	}

	// Reactive positions accounting for the hidden minimizeToTray row. Both the
	// program-mode row above and the compression-algorithm row below shift what
	// follows them, so every position is derived rather than written out.
	let minifyPos = $derived<NavPos>([0, trayVisible ? 4 : 3]);
	let compressPos = $derived<NavPos>([0, trayVisible ? 5 : 4]);
	let algorithmRow = $derived(trayVisible ? 6 : 5);
	let timeoutPos = $derived<NavPos>([0, algorithmRow + 1]);
	let buttonsY = $derived(algorithmRow + 2);

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

	.hint {
		font-size: 2vh;
		color: var(--secondary-foreground);
		line-height: 1.6;
		margin-top: 0.5vh;
	}
</style>

<div class="settings">
	<div class="container">
		<div role="group" data-mouse-activate-area={areaID}>
			<SwitchRow label={$t('settings.system.programModes.system') + ':'} checked={mode === 'system'} position={[0, 0]} onToggle={toggleMode} />
			<div class="hint">{$t('settings.system.programModeInfo.' + mode)}</div>
		</div>
		<div role="group" data-mouse-activate-area={areaID}>
			<SwitchRow label={$t('settings.system.autoStartOnBoot') + ':'} checked={autoStart} position={[0, 1]} onToggle={toggleAutoStart} />
		</div>
		<div role="group" data-mouse-activate-area={areaID}>
			<SwitchRow label={$t('settings.system.showInTray') + ':'} checked={trayVisible} position={[0, 2]} onToggle={toggleShowInTray} />
		</div>
		{#if trayVisible}
			<div role="group" data-mouse-activate-area={areaID}>
				<SwitchRow label={$t('settings.system.minimizeToTray') + ':'} checked={trayMinimize} position={[0, 3]} onToggle={toggleMinimizeToTray} />
			</div>
		{/if}
		<div role="group" data-mouse-activate-area={areaID}>
			<SwitchRow label={$t('settings.system.defaultMinifyJSON') + ':'} checked={minifyJSON} position={minifyPos} onToggle={toggleMinifyJSON} />
		</div>
		<div role="group" data-mouse-activate-area={areaID}>
			<SwitchRow label={$t('settings.system.defaultCompress') + ':'} checked={compress} position={compressPos} onToggle={toggleCompress} />
		</div>
		<div role="group" data-mouse-activate-area={areaID}>
			<CompressionAlgorithmRow label={$t('settings.system.defaultCompressionAlgorithm')} value={compressionAlgorithm} row={algorithmRow} onSelect={algorithm => (compressionAlgorithm = algorithm)} />
		</div>
		<div role="group" data-mouse-activate-area={areaID}>
			<Input bind:value={timeout} label={$t('settings.system.notificationTimeout')} type="number" position={timeoutPos} flex />
		</div>
	</div>
	<ButtonBar justify="center" basePosition={[0, buttonsY]}>
		<Button icon="/img/save.svg" label={$t('common.save')} onConfirm={saveSettings} />
		<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
	</ButtonBar>
</div>
