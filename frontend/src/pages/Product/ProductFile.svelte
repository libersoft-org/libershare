<script lang="ts">
	import { getContext } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import type { NavAreaController } from '../../scripts/navArea.svelte.ts';
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

<Row selected={rowSelected}>
	<div class="info">
		<div class="name">{name}</div>
		<div class="size">{$t('common.size')}: {size}</div>
	</div>
	<div class="actions">
		<Button label={$t('library.product.download')} position={[0, rowY]} />
		<Button label={$t('library.product.play')} position={[1, rowY]} />
	</div>
</Row>
