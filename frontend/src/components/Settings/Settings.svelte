<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { audioEnabled, cursorSize } from '../../scripts/settings.ts';
	import ButtonsGroup from '../Buttons/ButtonsGroup.svelte';
	import Button from '../Buttons/Button.svelte';
	import SettingsLanguage from './SettingsLanguage.svelte';
	import SettingsAudio from './SettingsAudio.svelte';
	import SettingsCursor from './SettingsCursor.svelte';
	interface Props {
		areaID: string;
		onBack?: () => void;
	}
	let { areaID, onBack }: Props = $props();
	let showLanguageDialog = $state(false);
	let showAudioDialog = $state(false);
	let showCursorDialog = $state(false);

	function openLanguageDialog() {
		showLanguageDialog = true;
	}

	function closeLanguageDialog() {
		showLanguageDialog = false;
	}

	function openAudioDialog() {
		showAudioDialog = true;
	}

	function closeAudioDialog() {
		showAudioDialog = false;
	}

	function openCursorDialog() {
		showCursorDialog = true;
	}

	function closeCursorDialog() {
		showCursorDialog = false;
	}
</script>

<style>
	.settings {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2vh;
		height: 100%;
	}
</style>

{#if showLanguageDialog}
	<SettingsLanguage {areaID} onBack={closeLanguageDialog} />
{:else if showAudioDialog}
	<SettingsAudio {areaID} onBack={closeAudioDialog} />
{:else if showCursorDialog}
	<SettingsCursor {areaID} onBack={closeCursorDialog} />
{:else}
	<div class="settings">
		<ButtonsGroup {areaID} {onBack}>
			<Button label={$t.settings?.language} onConfirm={openLanguageDialog} />
			<Button label="{$t.settings?.audio}: {$audioEnabled ? $t.common?.yes : $t.common?.no}" onConfirm={openAudioDialog} />
			<Button label="{$t.settings?.cursorSize}: {$t.settings?.cursorSizes?.[$cursorSize]}" onConfirm={openCursorDialog} />
			<Button label={$t.common?.back} onConfirm={onBack} />
		</ButtonsGroup>
	</div>
{/if}
