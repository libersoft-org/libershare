<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { type ILISH } from '@shared';
	import { api } from '../../scripts/api.ts';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	interface Props {
		lishs: ILISH[];
		downloadPath: string;
		position: Position;
		onDone: () => void;
	}
	let { lishs, downloadPath, position, onDone }: Props = $props();
	let overwriteQueue = $state<ILISH[]>([]);
	let newLISHs = $state<ILISH[]>([]);
	let currentOverwriteLISH = $derived(overwriteQueue.length > 0 ? overwriteQueue[0] : null);

	async function processLISHs(): Promise<void> {
		const toConfirm: ILISH[] = [];
		const toAdd: ILISH[] = [];
		for (const lish of lishs) {
			const existing = await api.lishs.get(lish.id);
			if (existing) toConfirm.push(lish);
			else toAdd.push(lish);
		}
		newLISHs = toAdd;
		if (toConfirm.length > 0) overwriteQueue = toConfirm;
		else await finishImport();
	}

	async function confirmOverwrite(): Promise<void> {
		if (currentOverwriteLISH) {
			await api.lishs.importFromJSON(JSON.stringify(currentOverwriteLISH), downloadPath, true);
			overwriteQueue = overwriteQueue.slice(1);
		}
		if (overwriteQueue.length === 0) await finishImport();
	}

	async function skipOverwrite(): Promise<void> {
		overwriteQueue = overwriteQueue.slice(1);
		if (overwriteQueue.length === 0) await finishImport();
	}

	async function finishImport(): Promise<void> {
		for (const lish of newLISHs) {
			await api.lishs.importFromJSON(JSON.stringify(lish), downloadPath);
		}
		newLISHs = [];
		onDone();
	}

	onMount(() => {
		processLISHs();
	});
</script>

{#if currentOverwriteLISH}
	<ConfirmDialog title={$t('common.import')} message={$t('lish.import.confirmOverwrite', { name: currentOverwriteLISH.name || currentOverwriteLISH.id, id: currentOverwriteLISH.id })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmOverwrite} onBack={skipOverwrite} />
{/if}
