<script lang="ts">
	import MenuTitle from './MenuTitle.svelte';
	import MenuItems from './MenuItems.svelte';

	interface Props {
		title?: string;
		items: Array<{ id: string; label: string }>;
		onselect?: (id: string) => void;
		onback?: () => void;
	}
	let { title = 'LiberShare', items, onselect, onback }: Props = $props();
</script>

<style>
	.menu {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100vh;
		padding: 0;
		box-sizing: border-box;
		overflow: hidden;
	}
</style>

<div class="menu">
	<MenuTitle {title} />
	<MenuItems {items} orientation="horizontal" scopeId="main-menu" {onselect} {onback} />
</div>
