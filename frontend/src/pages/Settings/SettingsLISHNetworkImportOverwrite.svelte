<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { type LISHNetworkDefinition } from '@shared';
	import { networkExists, addNetworkIfNotExists, getNetworkByID as getNetworkByID, updateNetwork } from '../../scripts/lishNetwork.ts';
	import { api } from '../../scripts/api.ts';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	interface Props {
		networks: LISHNetworkDefinition[];
		position: Position;
		onDone: () => void;
	}
	let { networks, position, onDone }: Props = $props();
	let overwriteQueue = $state<LISHNetworkDefinition[]>([]);
	let newNetworks = $state<LISHNetworkDefinition[]>([]);
	let connectQueue = $state<LISHNetworkDefinition[]>([]);
	let currentOverwriteNetwork = $derived(overwriteQueue.length > 0 ? overwriteQueue[0] : null);
	let currentConnectNetwork = $derived(connectQueue.length > 0 ? connectQueue[0] : null);

	async function processNetworks(): Promise<void> {
		const toConfirm: LISHNetworkDefinition[] = [];
		const toAdd: LISHNetworkDefinition[] = [];
		for (const network of networks) {
			if (await networkExists(network.networkID)) toConfirm.push(network);
			else toAdd.push(network);
		}
		newNetworks = toAdd;
		if (toConfirm.length > 0) overwriteQueue = toConfirm;
		else await addAndPromptConnect();
	}

	async function confirmOverwrite(): Promise<void> {
		if (currentOverwriteNetwork) {
			const existing = await getNetworkByID(currentOverwriteNetwork.networkID);
			if (existing) await updateNetwork({ ...currentOverwriteNetwork, enabled: existing.enabled });
			overwriteQueue = overwriteQueue.slice(1);
		}
		if (overwriteQueue.length === 0) await addAndPromptConnect();
	}

	async function skipOverwrite(): Promise<void> {
		overwriteQueue = overwriteQueue.slice(1);
		if (overwriteQueue.length === 0) await addAndPromptConnect();
	}

	// Add all newly imported networks (skipping existing ones) and queue them up for the
	// per-network "connect now?" prompt. Overwritten networks are not prompted: their
	// enabled state was preserved on update.
	async function addAndPromptConnect(): Promise<void> {
		const added: LISHNetworkDefinition[] = [];
		for (const network of newNetworks) {
			if (await addNetworkIfNotExists(network)) added.push(network);
		}
		newNetworks = [];
		if (added.length === 0) {
			onDone();
			return;
		}
		connectQueue = added;
	}

	async function confirmConnect(): Promise<void> {
		if (currentConnectNetwork) await api.lishnets.setEnabled(currentConnectNetwork.networkID, true);
		connectQueue = connectQueue.slice(1);
		if (connectQueue.length === 0) onDone();
	}

	function skipConnect(): void {
		connectQueue = connectQueue.slice(1);
		if (connectQueue.length === 0) onDone();
	}

	onMount(() => {
		processNetworks();
	});
</script>

{#if currentOverwriteNetwork}
	<ConfirmDialog title={$t('common.import')} message={$t('settings.lishNetwork.confirmOverwrite', { name: currentOverwriteNetwork.name, networkID: currentOverwriteNetwork.networkID })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmOverwrite} onBack={skipOverwrite} />
{:else if currentConnectNetwork}
	<ConfirmDialog title={$t('common.connect')} message={$t('settings.lishNetwork.confirmConnect', { name: currentConnectNetwork.name })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" defaultButton="confirm" {position} onConfirm={confirmConnect} onBack={skipConnect} />
{/if}
