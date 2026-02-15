<script lang="ts">
	import { type Snippet } from 'svelte';
	interface Props {
		justify?: string;
		wrap?: boolean;
		gap?: string;
		children: Snippet;
	}
	let { justify = 'flex-start', wrap = true, gap = '2vh', children }: Props = $props();
</script>

<style>
	.button-bar {
		display: flex;
	}
</style>

<div class="button-bar" style="justify-content: {justify}; gap: {gap}; {wrap ? ' flex-wrap: wrap;' : ''}">
	{@render children()}
</div>
