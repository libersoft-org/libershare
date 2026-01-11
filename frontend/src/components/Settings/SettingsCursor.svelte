<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { cursorSize, setCursorSize, type CursorSize } from '../../scripts/settings.ts';
	import MenuTitle from '../Menu/MenuTitle.svelte';
	import MenuBar from '../Menu/MenuBar.svelte';
	import ButtonsGroup from '../Buttons/ButtonsGroup.svelte';
	import Button from '../Buttons/Button.svelte';
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

<style>
	.cursor {
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

<div class="cursor">
	<MenuTitle title={$t.settings?.cursorSize} />
	<MenuBar>
		<ButtonsGroup {areaID} {onBack} {initialIndex}>
			{#each sizes as size}
				<Button label={$t.settings?.cursorSizes?.[size]} onConfirm={() => selectSize(size)} />
			{/each}
			<Button label={$t.common?.back} onConfirm={onBack} />
		</ButtonsGroup>
	</MenuBar>
</div>
