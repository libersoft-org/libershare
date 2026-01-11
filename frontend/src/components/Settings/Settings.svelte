<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { audioEnabled, cursorSize } from '../../scripts/settings.ts';
	import ButtonsGroup from '../Buttons/ButtonsGroup.svelte';
	import Button from '../Buttons/Button.svelte';
	import SettingsLanguage from './SettingsLanguage.svelte';
	import SettingsAudio from './SettingsAudio.svelte';
	import SettingsCursor from './SettingsCursor.svelte';
	import SettingsFooter from './SettingsFooter.svelte';
	interface Props {
		areaID: string;
		onBack?: () => void;
	}
	let { areaID, onBack }: Props = $props();
	let showLanguageDialog = $state(false);
	let showAudioDialog = $state(false);
	let showCursorDialog = $state(false);
	let showFooterDialog = $state(false);

	function openLanguageDialog() {
		pushBreadcrumb($t.settings?.language ?? '');
		showLanguageDialog = true;
	}

	function closeLanguageDialog() {
		popBreadcrumb();
		showLanguageDialog = false;
	}

	function openAudioDialog() {
		pushBreadcrumb($t.settings?.audio ?? '');
		showAudioDialog = true;
	}

	function closeAudioDialog() {
		popBreadcrumb();
		showAudioDialog = false;
	}

	function openCursorDialog() {
		pushBreadcrumb($t.settings?.cursorSize ?? '');
		showCursorDialog = true;
	}

	function closeCursorDialog() {
		popBreadcrumb();
		showCursorDialog = false;
	}

	function openFooterDialog() {
		pushBreadcrumb($t.settings?.footer ?? '');
		showFooterDialog = true;
	}

	function closeFooterDialog() {
		popBreadcrumb();
		showFooterDialog = false;
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
{:else if showFooterDialog}
	<SettingsFooter {areaID} onBack={closeFooterDialog} />
{:else}
	<div class="settings">
		<ButtonsGroup {areaID} {onBack}>
			<Button label={$t.settings?.language} onConfirm={openLanguageDialog} />
			<Button label="{$t.settings?.audio}: {$audioEnabled ? $t.common?.yes : $t.common?.no}" onConfirm={openAudioDialog} />
			<Button label="{$t.settings?.cursorSize}: {$t.settings?.cursorSizes?.[$cursorSize]}" onConfirm={openCursorDialog} />
			<Button label={$t.settings?.footer} onConfirm={openFooterDialog} />
			<Button label={$t.common?.back} onConfirm={onBack} />
		</ButtonsGroup>
	</div>
{/if}
