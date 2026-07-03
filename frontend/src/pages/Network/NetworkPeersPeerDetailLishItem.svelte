<script lang="ts">
	import { getContext } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import type { NavAreaController } from '../../scripts/navArea.svelte.ts';
	import { formatSize } from '../../scripts/utils.ts';
	import Row from '../../components/Row/Row.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	interface Props {
		name: string;
		id: string;
		totalSize?: number | undefined;
		rowY: number;
		disabled?: boolean;
		highlight?: boolean;
		onAdd: () => void;
		onDetails: () => void;
		el?: HTMLDivElement | undefined;
	}
	let { name, id, totalSize, rowY, disabled = false, highlight = false, onAdd, onDetails, el = $bindable() }: Props = $props();
	const navArea = getContext<NavAreaController | undefined>('navArea');
	let rowSelected = $derived(navArea ? navArea.isSelected([0, rowY]) || navArea.isSelected([1, rowY]) : false);
</script>

<style>
	.wrap {
		border-radius: 2vh;
		transition: box-shadow 0.4s ease;
	}
	.wrap.highlight {
		box-shadow:
			0 0 0 0.4vh var(--primary-foreground),
			0 0 2vh var(--primary-foreground);
	}
	.info {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.5vh;
		min-width: 0;
		flex: 1;
	}

	.info .name {
		font-size: 3vh;
		font-weight: bold;
		color: var(--primary-foreground);
		word-break: break-word;
	}

	.info .id {
		font-family: var(--font-mono);
		font-size: 1.8vh;
		color: var(--disabled-foreground);
		word-break: break-all;
	}

	.info .size {
		font-size: 1.8vh;
		color: var(--secondary-foreground);
	}

	.actions {
		display: flex;
		gap: 1vh;
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

<div class="wrap" class:highlight bind:this={el}>
	<Row selected={rowSelected}>
		<div class="info">
			<div class="name">{name}</div>
			{#if totalSize !== undefined}
				<div class="size">{formatSize(totalSize)}</div>
			{/if}
			<div class="id">{id}</div>
		</div>
		<div class="actions">
			<Button icon="/img/download.svg" label={$t('network.addToDownloads')} position={[0, rowY]} onConfirm={onAdd} {disabled} padding="1vh 1.5vh" fontSize="1.6vh" width="auto" />
			<Button icon="/img/info.svg" label={$t('network.details')} position={[1, rowY]} onConfirm={onDetails} padding="1vh 1.5vh" fontSize="1.6vh" width="auto" />
		</div>
	</Row>
</div>
