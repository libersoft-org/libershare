<script lang="ts">
	import { type Snippet, getContext, onMount } from 'svelte';
	import { type NavAreaController, type NavPos, navItem } from '../../scripts/navArea.svelte.ts';
	import { activateArea } from '../../scripts/areas.ts';
	interface Props {
		children: Snippet;
		selected?: boolean;
		dimmed?: boolean;
		el?: HTMLElement | undefined;
		position?: NavPos | undefined;
		onConfirm?: (() => void) | undefined;
	}
	let { children, selected = false, dimmed = false, el = $bindable(), position, onConfirm }: Props = $props();

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

	function handleClick() {
		if (navArea && position) {
			activateArea(navArea.areaID);
			navArea.select(position);
		}
		onConfirm?.();
	}

	function handleMouseEnter() {
		if (navArea && position) {
			activateArea(navArea.areaID);
			navArea.select(position);
		}
	}
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

	.row.selected {
		background-color: var(--primary-foreground);
		color: var(--primary-background);
	}

	.row.dimmed {
		opacity: 0.55;
	}

	.row.clickable {
		cursor: pointer;
	}

	.row:hover:not(.selected) {
		background-color: var(--secondary-background);
	}

	@media (max-width: 1199px) {
		.row {
			grid-template-columns: var(--table-columns-mobile);
		}
	}
</style>

<div bind:this={el} class="row" class:selected={isSelected} class:dimmed class:clickable={navArea && position} onclick={handleClick} onmouseenter={handleMouseEnter} role={navArea && position ? 'row' : undefined} tabindex="-1">
	{@render children()}
</div>
