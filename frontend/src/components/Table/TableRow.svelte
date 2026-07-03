<script lang="ts">
	import { type Snippet, getContext, onMount } from 'svelte';
	import { type NavAreaController, type NavPos, navItem } from '../../scripts/navArea.svelte.ts';
	interface Props {
		children: Snippet;
		selected?: boolean;
		dimmed?: boolean;
		el?: HTMLElement | undefined;
		position?: NavPos | undefined;
		onConfirm?: (() => void) | undefined;
		/** Direct DOM click handler for callers that don't use NavArea (e.g. FileBrowser). */
		onclick?: ((e: MouseEvent) => void) | undefined;
		/** Direct DOM mouseenter handler (mouse-driven row activation). */
		onmouseenter?: ((e: MouseEvent) => void) | undefined;
		/** Direct DOM keydown handler. */
		onkeydown?: ((e: KeyboardEvent) => void) | undefined;
	}
	let { children, selected = false, dimmed = false, el = $bindable(), position, onConfirm, onclick, onmouseenter, onkeydown }: Props = $props();

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

	.row.selected {
		background-color: var(--primary-foreground);
		color: var(--primary-background);
	}

	.row.dimmed {
		opacity: 0.55;
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

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div bind:this={el} class="row" class:selected={isSelected} class:dimmed role="row" tabindex={onclick || onkeydown ? -1 : undefined} {onclick} {onmouseenter} {onkeydown}>
	{@render children()}
</div>
