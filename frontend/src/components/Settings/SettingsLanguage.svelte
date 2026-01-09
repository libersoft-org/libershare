<script lang="ts">
	import { languages, setLanguage, currentLanguage, t } from '../../scripts/language.ts';
	import ButtonsGroup from '../Buttons/ButtonsGroup.svelte';
	import Button from '../Buttons/Button.svelte';
	import Dialog from '../Dialog/Dialog.svelte';
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

<Dialog title={$t.settings?.language}>
	<ButtonsGroup {areaID} {onBack} {initialIndex}>
		{#each languages as lang (lang.id)}
			<Button label={lang.label !== lang.nativeLabel ? `${lang.label} (${lang.nativeLabel})` : lang.label} onConfirm={() => selectLanguage(lang.id)} />
		{/each}
		<Button label={$t.common?.back} onConfirm={onBack} />
	</ButtonsGroup>
</Dialog>
