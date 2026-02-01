<script lang="ts">
	import { type Snippet } from 'svelte';
	interface Props {
		children: Snippet;
		selected?: boolean;
		odd?: boolean;
	}
	let { children, selected = false, odd = false }: Props = $props();
</script>

<style>
	.row {
		display: grid;
		align-items: center;
		padding: 1.5vh 2vh;
		border-bottom: 0.2vh solid var(--secondary-softer-background);
		grid-template-columns: var(--table-columns);
		gap: var(--table-gap);
	}

	.row:last-child {
		border-bottom: none;
	}

	.row.odd {
		background-color: var(--secondary-soft-background);
	}

	.row.even {
		background-color: var(--secondary-softer-background);
	}

	.row.selected {
		background-color: var(--primary-foreground);
		color: var(--primary-background);
	}

	@media (max-width: 1199px) {
		.row {
			grid-template-columns: var(--table-columns-mobile);
		}
	}
</style>

<div class="row" class:odd class:even={!odd} class:selected>
	{@render children()}
</div>
