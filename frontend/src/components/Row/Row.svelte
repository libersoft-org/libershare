<script lang="ts">
	import type { Snippet } from 'svelte';
	interface Props {
		selected?: boolean;
		children?: Snippet;
	}
	let { selected = false, children }: Props = $props();
</script>

<style>
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 1vh;
		padding: 2vh;
		background-color: var(--secondary-background);
		border: 0.4vh solid var(--secondary-softer-background);
		border-radius: 2vh;
		transition: all 0.2s linear;
	}

	.row.selected {
		background-color: var(--secondary-hard-background);
		border-color: var(--primary-foreground);
	}
</style>

<div class="row" class:selected>
	{#if children}{@render children()}{/if}
</div>
