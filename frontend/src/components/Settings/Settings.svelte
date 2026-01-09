<script lang="ts">
	import ButtonsGroup from '../Buttons/ButtonsGroup.svelte';
	import Button from '../Buttons/Button.svelte';
	import SettingsLanguage from './SettingsLanguage.svelte';
	interface Props {
		areaID: string;
		onBack?: () => void;
	}
	let { areaID, onBack }: Props = $props();
	let showLanguageDialog = $state(false);

	function openLanguageDialog() {
		showLanguageDialog = true;
	}

	function closeLanguageDialog() {
		showLanguageDialog = false;
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
{:else}
	<div class="settings">
		<ButtonsGroup {areaID} {onBack}>
			<Button label="Language" onConfirm={openLanguageDialog} />
			<Button label="Back" onConfirm={onBack} />
		</ButtonsGroup>
	</div>
{/if}
