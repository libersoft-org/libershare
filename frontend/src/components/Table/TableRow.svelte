<script lang="ts">
	import type { Snippet } from 'svelte';
	interface Props {
		children: Snippet;
		selected?: boolean;
		odd?: boolean;
	}
	let { children, selected = false, odd = false }: Props = $props();
</script>

<style>
	.row {
		display: flex;
		align-items: center;
		padding: 1.5vh 2vh;
		border-bottom: 0.2vh solid var(--secondary-softer-background);
	}

	.row:last-child {
		border-bottom: none;
	}

	.row.odd {
		background-color: var(--secondary-soft-background);
	}

	.row.even {
		background-color: var(--secondary-background);
	}

	.row.selected {
		background-color: var(--primary-foreground);
		color: var(--primary-background);
	}
</style>

<div class="row" class:odd class:even={!odd} class:selected>
	{@render children()}
</div>
