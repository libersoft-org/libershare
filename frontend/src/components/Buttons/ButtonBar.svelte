<script lang="ts">
	import { type Snippet } from 'svelte';
	interface Props {
		justify?: string;
		wrap?: boolean;
		gap?: string;
		direction?: 'row' | 'column';
		children: Snippet;
		el?: HTMLElement | undefined;
	}
	let { justify = 'flex-start', wrap = true, gap = '2vh', direction = 'row', children, el = $bindable() }: Props = $props();
	void el;
</script>

<style>
	.button-bar {
		display: flex;
	}
</style>

<div bind:this={el} class="button-bar" style="flex-direction: {direction}; justify-content: {justify}; gap: {gap}; {wrap ? ' flex-wrap: wrap;' : ''}">
	{@render children()}
</div>
