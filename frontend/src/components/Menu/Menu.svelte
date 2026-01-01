<script lang="ts">
	import MenuTitle from './MenuTitle.svelte';
	import MenuItems from './MenuItems.svelte';

	interface Props {
		title: string;
		items: Array<{ id: string; label: string }>;
		orientation?: 'horizontal' | 'vertical';
		selectedId?: string;
		onselect?: (id: string) => void;
		onback?: () => void;
	}
	let { title, items, orientation = 'horizontal', selectedId, onselect, onback }: Props = $props();
</script>

<style>
	.menu {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 0;
		box-sizing: border-box;
		overflow: hidden;
	}
</style>

<div class="menu">
	<MenuTitle {title} />
	{#key `${title}-${selectedId}-${orientation}`}
		<MenuItems {items} {orientation} sceneId="menu" {selectedId} {onselect} {onback} />
	{/key}
</div>
