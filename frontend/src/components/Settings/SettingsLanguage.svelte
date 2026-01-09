<script lang="ts">
	import ButtonsGroup from '../Buttons/ButtonsGroup.svelte';
	import Button from '../Buttons/Button.svelte';
	import Dialog from '../Dialog/Dialog.svelte';
	import { languages, setLanguage } from '../../scripts/language.ts';
	interface Props {
		areaID: string;
		onBack?: () => void;
	}
	let { areaID, onBack }: Props = $props();

	function selectLanguage(languageID: string) {
		setLanguage(languageID);
		onBack?.();
	}
</script>

<Dialog title="Language">
	<ButtonsGroup {areaID} {onBack}>
		{#each languages as lang (lang.id)}
			<Button label={lang.label !== lang.nativeLabel ? `${lang.label} (${lang.nativeLabel})` : lang.label} onConfirm={() => selectLanguage(lang.id)} />
		{/each}
		<Button label="Back" onConfirm={onBack} />
	</ButtonsGroup>
</Dialog>
