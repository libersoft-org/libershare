<script lang="ts">
	import { type Snippet } from 'svelte';
	interface Props {
		children: Snippet;
		columns?: string;
		columnsMobile?: string;
		gap?: string;
		noBorder?: boolean;
	}
	let { children, columns = '1fr', columnsMobile = '1fr', gap = '2vh', noBorder = false }: Props = $props();
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
</style>

<div class="table" class:no-border={noBorder} style="--table-columns: {columns}; --table-columns-mobile: {columnsMobile}; --table-gap: {gap};">
	{@render children()}
</div>
