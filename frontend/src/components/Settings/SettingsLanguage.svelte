<script lang="ts">
	import { languages, setLanguage, currentLanguage, t } from '../../scripts/language.ts';
	import MenuTitle from '../Menu/MenuTitle.svelte';
	import MenuBar from '../Menu/MenuBar.svelte';
	import ButtonsGroup from '../Buttons/ButtonsGroup.svelte';
	import Button from '../Buttons/Button.svelte';
	interface Props {
		areaID: string;
		onBack?: () => void;
	}
	let { areaID, onBack }: Props = $props();
	let initialIndex = $derived(languages.findIndex(l => l.id === $currentLanguage));

	function selectLanguage(languageID: string) {
		setLanguage(languageID);
		onBack?.();
	}
</script>

<style>
	.settings-page {
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		overflow: hidden;
	}
</style>

<div class="settings-page">
	<MenuTitle title={$t.settings?.language} />
	<MenuBar>
		<ButtonsGroup {areaID} {onBack} {initialIndex}>
			{#each languages as lang (lang.id)}
				<Button label={lang.label !== lang.nativeLabel ? `${lang.label} (${lang.nativeLabel})` : lang.label} onConfirm={() => selectLanguage(lang.id)} />
			{/each}
			<Button label={$t.common?.back} onConfirm={onBack} />
		</ButtonsGroup>
	</MenuBar>
</div>
