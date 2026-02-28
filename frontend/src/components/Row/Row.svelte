<script lang="ts">
	import { type Snippet } from 'svelte';
	interface Props {
		selected?: boolean;
		disabled?: boolean;
		children?: Snippet;
	}
	let { selected = false, disabled = false, children }: Props = $props();
</script>

<style>
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 1vh;
		padding: 2vh;
		border: 0.4vh solid var(--secondary-softer-background);
		border-radius: 2vh;
		transition: all 0.2s linear;
		background-color: var(--secondary-background);
		color: var(--secondary-foreground);
	}

	.row.selected {
		background-color: var(--secondary-hard-background);
		border-color: var(--primary-foreground);
	}

	.row.disabled {
		background-color: var(--disabled-foreground);
		color: var(--disabled-background);
	}
</style>

<div class="row" class:selected class:disabled>
	{#if children}{@render children()}{/if}
</div>
