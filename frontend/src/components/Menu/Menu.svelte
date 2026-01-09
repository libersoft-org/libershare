<script lang="ts">
	import MenuTitle from './MenuTitle.svelte';
	import MenuBar from './MenuBar.svelte';
	import ButtonsGroup from '../Buttons/ButtonsGroup.svelte';
	import Button from '../Buttons/Button.svelte';

	interface Props {
		title: string;
		items: Array<{ id: string; label: string }>;
		orientation?: 'horizontal' | 'vertical';
		selectedId?: string;
		onselect?: (id: string) => void;
		onBack?: () => void;
	}
	let { title, items, orientation = 'horizontal', selectedId, onselect, onBack }: Props = $props();
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
		flex: 1;
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
			<ButtonsGroup areaID="menu" {initialIndex} {orientation} wrap={true} {onBack}>
				{#each items as item (item.id)}
					<Button label={item.label} onConfirm={() => onselect?.(item.id)} />
				{/each}
			</ButtonsGroup>
		{/key}
	</MenuBar>
</div>
