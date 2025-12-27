<script lang="ts">
	import MenuTitle from './MenuTitle.svelte';
	import MenuItems from './MenuItems.svelte';

	interface Props {
		onselect?: (id: string) => void;
		onback?: () => void;
	}
	let { onselect, onback }: Props = $props();
	const items = [
		{ id: 'back', label: 'Back' },
		{ id: 'restart', label: 'Restart' },
		{ id: 'shutdown', label: 'Shutdown' },
		{ id: 'exit', label: 'Exit Application' },
	];
</script>

<style>
	.menu {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100vh;
		padding: 2rem;
		box-sizing: border-box;
		overflow: hidden;
	}
</style>

<div class="menu">
	<MenuTitle title="Exit" />
	<MenuItems {items} orientation="vertical" scopeId="exit-menu" {onselect} {onback} />
</div>
