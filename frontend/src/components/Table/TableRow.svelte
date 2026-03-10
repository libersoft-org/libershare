<script lang="ts">
	import { type Snippet, getContext, onMount } from 'svelte';
	import { type NavAreaController, type NavPos, navItem } from '../../scripts/navArea.svelte.ts';
	interface Props {
		children: Snippet;
		selected?: boolean;
		odd?: boolean;
		el?: HTMLElement | undefined;
		position?: NavPos | undefined;
		onConfirm?: (() => void) | undefined;
	}
	let { children, selected = false, odd = false, el = $bindable(), position, onConfirm }: Props = $props();

	const navArea = getContext<NavAreaController | undefined>('navArea');

	let isSelected = $derived(navArea && position ? navArea.isSelected(position) : selected);

	onMount(() => {
		if (navArea && position) {
			return navArea.register(
				navItem(
					() => position!,
					() => el,
					onConfirm
				)
			);
		}
		return undefined;
	});
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

<div bind:this={el} class="row" class:odd class:even={!odd} class:selected={isSelected}>
	{@render children()}
</div>
