<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { cursorSize, setCursorSize, type CursorSize } from '../../scripts/settings.ts';
	import ButtonsGroup from '../Buttons/ButtonsGroup.svelte';
	import Button from '../Buttons/Button.svelte';
	import Dialog from '../Dialog/Dialog.svelte';
	interface Props {
		areaID: string;
		onBack?: () => void;
	}
	let { areaID, onBack }: Props = $props();
	const sizes: CursorSize[] = ['small', 'medium', 'large'];
	let initialIndex = $derived(sizes.indexOf($cursorSize));

	function selectSize(size: CursorSize) {
		setCursorSize(size);
		onBack?.();
	}
</script>

<Dialog title={$t.settings?.cursorSize}>
	<ButtonsGroup {areaID} {onBack} {initialIndex}>
		{#each sizes as size}
			<Button label={$t.settings?.cursorSizes?.[size]} onConfirm={() => selectSize(size)} />
		{/each}
		<Button label={$t.common?.back} onConfirm={onBack} />
	</ButtonsGroup>
</Dialog>
