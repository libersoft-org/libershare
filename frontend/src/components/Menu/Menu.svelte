<script lang="ts">
	import MenuTitle from './MenuTitle.svelte';
	import MenuBar from './MenuBar.svelte';
	import ButtonsGroup from '../Buttons/ButtonsGroup.svelte';
	import Button from '../Buttons/Button.svelte';
	import type { Position } from '../../scripts/navigationLayout.ts';

	interface Props {
		areaID: string;
		title: string;
		items: Array<{ id: string; label: string; icon?: string; selected?: boolean }>;
		orientation?: 'horizontal' | 'vertical';
		selectedId?: string;
		buttonWidth?: string;
		position: Position;
		onselect?: (id: string) => void;
		onBack?: () => void;
	}
	let { areaID, title, items, orientation = 'horizontal', selectedId, buttonWidth, position, onselect, onBack }: Props = $props();
	let initialIndex = $derived(
		selectedId
			? Math.max(
					0,
					items.findIndex(i => i.id === selectedId)
				)
			: 0
	);
</script>

<style>
	.menu {
		width: 100%;
		height: 100%;
		/*flex: 1;*/
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		overflow: hidden;
	}
</style>

<div class="menu">
	<MenuTitle {title} />
	<MenuBar>
		{#key `${title}-${selectedId}-${orientation}`}
			<ButtonsGroup {areaID} {position} {initialIndex} {orientation} {onBack}>
				{#each items as item (item.id)}
					<Button label={item.label} icon={item.selected ? '/img/check.svg' : item.icon} iconPosition="top" iconSize="6vh" width={buttonWidth} onConfirm={() => onselect?.(item.id)} />
				{/each}
			</ButtonsGroup>
		{/key}
	</MenuBar>
</div>
