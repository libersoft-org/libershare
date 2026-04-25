<script lang="ts">
	import { type NavPos, createNavArea, navItem } from '../../scripts/navArea.svelte.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { type BreadcrumbItem } from '../../scripts/breadcrumb.ts';
	import Icon from '../Icon/Icon.svelte';
	interface Props {
		areaID: string;
		items: BreadcrumbItem[];
		position: Position;
		onSelect?: ((item: BreadcrumbItem, index: number) => void) | undefined;
		onBack?: (() => void) | undefined;
		onDown?: (() => string | false) | undefined;
	}
	let { areaID, items, position, onSelect, onBack, onDown }: Props = $props();

	const navHandle = createNavArea(() => ({
		areaID,
		position,
		onBack,
		onDown,
		onActivate() {
			const lastIDx = Math.max(0, items.length - 2);
			navHandle.controller.select([lastIDx, 0]);
		},
	}));

	function registerItem(node: HTMLElement, selectableIndex: number) {
		let cleanup: (() => void) | undefined;
		function setup(idx: number) {
			cleanup?.();
			cleanup = undefined;
			if (idx < 0) return;
			cleanup = navHandle.controller.register(
				navItem(
					() => [idx, 0] as NavPos,
					() => node,
					() => {
						const item = items[idx];
						if (item) onSelect?.(item, idx);
					}
				)
			);
		}
		setup(selectableIndex);
		return {
			update(newIDx: number) {
				setup(newIDx);
			},
			destroy() {
				cleanup?.();
			},
		};
	}
</script>

<style>
	.breadcrumb {
		flex-wrap: wrap;
		width: 100%;
		padding: 1vh 1.5vh;
		background-color: var(--secondary-soft-background);
		font-size: 2vh;
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 0.5vh;
		border-bottom: 0.2vh solid var(--secondary-softer-background);
	}

	.item {
		color: var(--disabled-foreground);
		padding: 0.5vh;
		border-radius: 1vh;
	}

	.item.current {
		color: var(--primary-foreground);
		font-weight: bold;
	}

	.item.selected {
		background-color: var(--primary-foreground);
		color: var(--secondary-background);
	}

	.item.clickable:hover:not(.selected) {
		color: var(--secondary-foreground);
		background-color: var(--secondary-softer-background);
	}
</style>

<div class="breadcrumb">
	{#each items as item, index (item.id)}
		{#if index > 0}
			<Icon img="/img/caret-right.svg" size="2vh" padding="0" colorVariable="--disabled-foreground" />
		{/if}
		{@const isSelected = navHandle.controller.isSelected([index, 0])}
		<div
			use:registerItem={index < items.length - 1 ? index : -1}
			class="item"
			class:current={index === items.length - 1}
			class:selected={isSelected}
			class:clickable={index < items.length - 1}
			role={index < items.length - 1 ? 'button' : undefined}
		>
			{#if item.icon}
				<Icon img={item.icon} size="2vh" padding="0" colorVariable={isSelected ? '--primary-background' : '--disabled-foreground'} />
			{:else}
				{item.name}
			{/if}
		</div>
	{/each}
</div>
