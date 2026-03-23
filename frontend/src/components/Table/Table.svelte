<script lang="ts">
	import { type Snippet } from 'svelte';
	interface Props {
		children: Snippet;
		columns?: string;
		columnsMobile?: string;
		gap?: string;
		noBorder?: boolean;
		oddEven?: boolean;
	}
	let { children, columns = '1fr', columnsMobile = '1fr', gap = '2vh', noBorder = false, oddEven = true }: Props = $props();
</script>

<style>
	.table {
		display: flex;
		flex-direction: column;
		border: 0.2vh solid var(--secondary-softer-background);
		border-radius: 1vh;
		overflow: hidden;
		width: 100%;
		color: var(--secondary-foreground);
	}

	.table.no-border {
		border: none;
		border-radius: 0;
	}

	.table.odd-even :global(.row:not(.selected):nth-child(odd)) {
		background-color: var(--secondary-soft-background);
	}

	.table.odd-even :global(.row:not(.selected):nth-child(even)) {
		background-color: var(--secondary-softer-background);
	}
</style>

<div class="table" class:no-border={noBorder} class:odd-even={oddEven} style="--table-columns: {columns}; --table-columns-mobile: {columnsMobile}; --table-gap: {gap};">
	{@render children()}
</div>
