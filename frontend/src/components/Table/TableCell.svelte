<script lang="ts">
	import type { Snippet } from 'svelte';
	interface Props {
		children: Snippet;
		width?: string;
		align?: 'left' | 'center' | 'right';
	}
	let { children, width, align = 'left' }: Props = $props();
	let justifyContent = $derived(align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center');
</script>

<style>
	.cell {
		display: flex;
		align-items: center;
		font-size: 2vh;
		font-weight: 500;
	}
</style>

<div class="cell" style="width: {width ?? 'auto'}; justify-content: {justifyContent};">
	{@render children()}
</div>
