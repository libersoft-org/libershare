<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { type NavAreaController, navItem } from '../../scripts/navArea.svelte.ts';
	import Row from '../../components/Row/Row.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	interface Props {
		name: string;
		size: string;
		rowY: number;
	}
	let { name, size, rowY }: Props = $props();
	const navArea = getContext<NavAreaController | undefined>('navArea');
	let rowSelected = $derived(navArea ? navArea.isSelected([0, rowY]) || navArea.isSelected([1, rowY]) : false);
	// Mouse-only NavItem: delegates hover to select the row's first button position so
	// hovering over the file name / size area (outside the buttons) still highlights
	// the row. Buttons opt out of mouse delegation, so this row-level item picks up
	// hover events anywhere on the row container without colliding with button clicks.
	let rowEl = $state<HTMLElement | undefined>();
	onMount(() => {
		if (!navArea) return;
		return navArea.register(
			navItem(
				() => [0, rowY] as const,
				() => rowEl
			)
		);
	});
</script>

<style>
	.info {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.5vh;
	}

	.info .name {
		font-size: 3vh;
		font-weight: bold;
		color: var(--secondary-foreground);
	}

	.info .size {
		font-size: 2vh;
		color: var(--disabled-foreground);
	}

	.actions {
		display: flex;
		gap: 2vh;
	}

	@media (max-width: 768px) {
		.actions {
			width: 100%;
		}

		.actions :global(.button) {
			flex: 1;
			min-width: unset;
		}
	}
</style>

<Row selected={rowSelected} bind:el={rowEl}>
	<div class="info">
		<div class="name">{name}</div>
		<div class="size">{$t('common.size')}: {size}</div>
	</div>
	<div class="actions">
		<Button label={$t('library.product.download')} position={[0, rowY]} />
		<Button label={$t('library.product.play')} position={[1, rowY]} />
	</div>
</Row>
