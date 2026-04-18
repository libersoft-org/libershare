<script lang="ts">
	import { getContext } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import type { NavAreaController } from '../../scripts/navArea.svelte.ts';
	import Row from '../../components/Row/Row.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	interface Props {
		name: string;
		id: string;
		rowY: number;
		disabled?: boolean;
		onAdd: () => void;
		onDetails: () => void;
	}
	let { name, id, rowY, disabled = false, onAdd, onDetails }: Props = $props();
	const navArea = getContext<NavAreaController | undefined>('navArea');
	let rowSelected = $derived(navArea ? navArea.isSelected([0, rowY]) || navArea.isSelected([1, rowY]) : false);
</script>

<style>
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
		color: var(--secondary-foreground);
		word-break: break-word;
	}

	.info .id {
		font-family: var(--font-mono);
		font-size: 1.8vh;
		color: var(--disabled-foreground);
		word-break: break-all;
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
		<div class="id">{id}</div>
	</div>
	<div class="actions">
		<Button icon="/img/download.svg" label={$t('peers.addToDownloads')} position={[0, rowY]} onConfirm={onAdd} {disabled} />
		<Button icon="/img/info.svg" label={$t('peers.details')} position={[1, rowY]} onConfirm={onDetails} />
	</div>
</Row>
