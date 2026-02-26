<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { type LISHNetworkDefinition } from '@shared';
	import { networkExists, addNetworkIfNotExists, getNetworkById, updateNetwork } from '../../scripts/lishNetwork.ts';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';

	interface Props {
		networks: LISHNetworkDefinition[];
		position: Position;
		onDone: () => void;
	}
	let { networks, position, onDone }: Props = $props();

	let overwriteQueue = $state<LISHNetworkDefinition[]>([]);
	let newNetworks = $state<LISHNetworkDefinition[]>([]);
	let currentOverwriteNetwork = $derived(overwriteQueue.length > 0 ? overwriteQueue[0] : null);

	async function processNetworks(): Promise<void> {
		const toConfirm: LISHNetworkDefinition[] = [];
		const toAdd: LISHNetworkDefinition[] = [];

		for (const network of networks) {
			if (await networkExists(network.networkID)) {
				toConfirm.push(network);
			} else {
				toAdd.push(network);
			}
		}

		newNetworks = toAdd;

		if (toConfirm.length > 0) {
			overwriteQueue = toConfirm;
		} else {
			await finishImport();
		}
	}

	async function confirmOverwrite(): Promise<void> {
		if (currentOverwriteNetwork) {
			const existing = await getNetworkById(currentOverwriteNetwork.networkID);
			if (existing) {
				await updateNetwork({ ...currentOverwriteNetwork, enabled: existing.enabled });
			}
			overwriteQueue = overwriteQueue.slice(1);
		}

		if (overwriteQueue.length === 0) {
			await finishImport();
		}
	}

	async function skipOverwrite(): Promise<void> {
		overwriteQueue = overwriteQueue.slice(1);

		if (overwriteQueue.length === 0) {
			await finishImport();
		}
	}

	async function finishImport(): Promise<void> {
		for (const network of newNetworks) {
			await addNetworkIfNotExists(network);
		}
		newNetworks = [];
		onDone();
	}

	onMount(() => {
		processNetworks();
	});
</script>

{#if currentOverwriteNetwork}
	<ConfirmDialog title={$t('common.import')} message={$t('settings.lishNetwork.confirmOverwrite', { name: currentOverwriteNetwork.name, networkID: currentOverwriteNetwork.networkID })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmOverwrite} onBack={skipOverwrite} />
{/if}
