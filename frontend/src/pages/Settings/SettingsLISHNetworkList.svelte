<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb, navigateTo } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { type LISHNetworkConfig, type NetworkNodeInfo } from '@libershare/shared';
	import { api } from '../../scripts/api.ts';
	import { getNetworks, deleteNetwork as deleteNetworkFromApi, updateNetwork as updateNetworkFromApi, addNetwork as addNetworkFromApi, formDataToNetwork, type NetworkFormData } from '../../scripts/lishNetwork.ts';
	import { scrollToElement } from '../../scripts/utils.ts';
	import Button from '../../components/Buttons/Button.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	import Row from '../../components/Row/Row.svelte';
	import LISHNetworkAddEdit from './SettingsLISHNetworkAddEdit.svelte';
	import LISHNetworkExport from './SettingsLISHNetworkExport.svelte';
	import LISHNetworkExportAll from './SettingsLISHNetworkExportAll.svelte';
	import LISHNetworkPublic from './SettingsLISHNetworkPublic.svelte';
	import LISHNetworkPeers from './SettingsLISHNetworkPeers.svelte';
	interface Props {
		areaID: string;
		position?: Position;
		onBack?: () => void;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();
	let unregisterArea: (() => void) | null = null;
	let removeBackHandler: (() => void) | null = null;
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0);
	let buttonIndex = $state(0); // 0 = Add, 1 = Import (for top row); 0 = Connect, 1 = Edit, 2 = Delete (for network rows)
	let showAddEdit = $state(false);
	let showExport = $state(false);
	let showExportAll = $state(false);
	let showPublic = $state(false);
	let showDeleteConfirm = $state(false);
	let showPeers = $state(false);
	let editingNetwork = $state<LISHNetworkConfig | null>(null);
	let exportingNetwork = $state<LISHNetworkConfig | null>(null);
	let deletingNetwork = $state<LISHNetworkConfig | null>(null);
	let peersNetwork = $state<LISHNetworkConfig | null>(null);
	let rowElements: HTMLElement[] = $state([]);
	// Networks loaded from backend
	let networks = $state<LISHNetworkConfig[]>([]);
	let globalNodeInfo = $state<NetworkNodeInfo | null>(null);
	let networkErrors = $state<Record<string, string>>({});

	async function loadNodeInfo() {
		try {
			globalNodeInfo = await api.networks.getNodeInfo();
		} catch (e: any) {
			globalNodeInfo = null;
		}
	}

	async function loadNetworks() {
		networks = await getNetworks();
		await loadNodeInfo();
	}

	// Items: Top buttons row (0), network rows (1 to networks.length)
	let totalItems = $derived(networks.length + 1);
	// Check if current row is the top row (has Back/Add/Import buttons)
	let isTopRow = $derived(selectedIndex === 0);
	// Check if current row is a network row (has Edit/Delete buttons)
	let isNetworkRow = $derived(selectedIndex > 0 && selectedIndex < totalItems);

	function openPublic() {
		showPublic = true;
		// Unregister our area - sub-component will create its own
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb($t('settings.lishNetwork.publicList'));
		removeBackHandler = pushBackHandler(handlePublicBack);
	}

	async function handlePublicBack() {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		showPublic = false;
		// Reload networks in case new ones were added
		await loadNetworks();
		// Wait for sub-component to unmount before re-registering
		await tick();
		unregisterArea = registerAreaHandler();
		activateArea(areaID);
	}

	function openAddNetwork() {
		editingNetwork = null;
		showAddEdit = true;
		// Unregister our area - sub-component will create its own
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb($t('common.add'));
		removeBackHandler = pushBackHandler(handleAddEditBack);
	}

	function openImport() {
		navigateTo('import-lishnet');
	}

	function openExportAll() {
		showExportAll = true;
		// Unregister our area - sub-component will create its own
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb($t('common.exportAll'));
		removeBackHandler = pushBackHandler(handleExportAllBack);
	}

	async function handleExportAllBack() {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		showExportAll = false;
		// Wait for sub-component to unmount before re-registering
		await tick();
		unregisterArea = registerAreaHandler();
		activateArea(areaID);
	}

	async function connectNetwork(network: LISHNetworkConfig) {
		// Toggle enabled state
		const newEnabled = !network.enabled;
		network.enabled = newEnabled;
		networks = [...networks]; // Trigger reactivity
		// Clear previous error for this network
		const { [network.networkID]: _err, ...restErrors } = networkErrors;
		networkErrors = restErrors;
		try {
			await api.networks.setEnabled(network.networkID, newEnabled);
		} catch (e: any) {
			networkErrors = { ...networkErrors, [network.networkID]: e?.message || 'Connection failed' };
		}
	}

	async function moveNetwork(index: number, up: boolean) {
		const newIndex = up ? index - 1 : index + 1;
		if (newIndex < 0 || newIndex >= networks.length) return;
		const temp = networks[index];
		networks[index] = networks[newIndex];
		networks[newIndex] = temp;
		networks = [...networks]; // Trigger reactivity
		// Move selection with the item (immediately, before async call)
		selectedIndex += up ? -1 : 1;
		// Adjust buttonIndex if moved to first/last position where some buttons don't exist
		const isNowFirst = newIndex === 0;
		const isNowLast = newIndex === networks.length - 1;
		// First item has max 6 buttons (0-5), last item has max 6 buttons (0-5), middle has 7 (0-6)
		const maxButtonIndex = isNowFirst || isNowLast ? 5 : 6;
		if (buttonIndex > maxButtonIndex) buttonIndex = maxButtonIndex;
		// Save new order to backend
		await api.lishNetworks.setAll(networks);
	}

	function openPeers(network: LISHNetworkConfig) {
		peersNetwork = network;
		showPeers = true;
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb(`${network.name} - ${$t('settings.lishNetwork.peerList')}`);
		removeBackHandler = pushBackHandler(handlePeersBack);
	}

	async function handlePeersBack() {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		showPeers = false;
		peersNetwork = null;
		await tick();
		unregisterArea = registerAreaHandler();
		activateArea(areaID);
	}

	function openExport(network: LISHNetworkConfig) {
		exportingNetwork = network;
		showExport = true;
		// Unregister our area - sub-component will create its own
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb(`${network.name} - ${$t('common.export')}`);
		removeBackHandler = pushBackHandler(handleExportBack);
	}

	async function handleExportBack() {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		showExport = false;
		exportingNetwork = null;
		// Wait for sub-component to unmount before re-registering
		await tick();
		unregisterArea = registerAreaHandler();
		activateArea(areaID);
	}

	function openEditNetwork(network: LISHNetworkConfig) {
		editingNetwork = network;
		showAddEdit = true;
		// Unregister our area - sub-component will create its own
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb(`${network.name} - ${$t('common.edit')}`);
		removeBackHandler = pushBackHandler(handleAddEditBack);
	}

	function deleteNetwork(network: LISHNetworkConfig) {
		deletingNetwork = network;
		showDeleteConfirm = true;
		// Unregister our area - ConfirmDialog will create its own
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb(`${network.name} - ${$t('common.delete')}`);
	}

	async function confirmDeleteNetwork() {
		if (deletingNetwork) {
			await deleteNetworkFromApi(deletingNetwork.networkID);
			networks = networks.filter(n => n.networkID !== deletingNetwork!.networkID);
			// Adjust selected index if needed
			if (selectedIndex >= totalItems) selectedIndex = totalItems - 1;
			buttonIndex = 0;
			deletingNetwork = null;
			showDeleteConfirm = false;
			popBreadcrumb();
			// Wait for sub-component to unmount before re-registering
			await tick();
			unregisterArea = registerAreaHandler();
			activateArea(areaID);
		}
	}

	async function cancelDelete() {
		deletingNetwork = null;
		showDeleteConfirm = false;
		popBreadcrumb();
		// Wait for sub-component to unmount before re-registering
		await tick();
		unregisterArea = registerAreaHandler();
		activateArea(areaID);
	}

	async function handleAddEditBack() {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		showAddEdit = false;
		editingNetwork = null;
		// Wait for sub-component to unmount before re-registering
		await tick();
		unregisterArea = registerAreaHandler();
		activateArea(areaID);
	}

	async function handleSave(savedNetwork: NetworkFormData) {
		const network = formDataToNetwork(savedNetwork, editingNetwork ?? undefined);
		if (editingNetwork) {
			// Update existing
			await updateNetworkFromApi(network);
			const index = networks.findIndex(n => n.networkID === editingNetwork!.networkID);
			if (index !== -1) networks[index] = network;
		} else {
			// Add new - backend generates networkID and key if empty
			await addNetworkFromApi(network);
			// Reload from backend to get the generated values
			await loadNetworks();
		}
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		showAddEdit = false;
		editingNetwork = null;
		// Wait for sub-component to unmount before re-registering
		await tick();
		unregisterArea = registerAreaHandler();
		activateArea(areaID);
	}

	const scrollToSelected = () => scrollToElement(rowElements, selectedIndex);

	function registerAreaHandler() {
		return useArea(
			areaID,
			{
				up: () => {
					if (selectedIndex > 0) {
						selectedIndex--;
						buttonIndex = 0;
						scrollToSelected();
						return true;
					}
					return false;
				},
				down: () => {
					if (selectedIndex < totalItems - 1) {
						selectedIndex++;
						buttonIndex = 0;
						scrollToSelected();
						return true;
					}
					return false;
				},
				left: () => {
					if ((isTopRow || isNetworkRow) && buttonIndex > 0) {
						buttonIndex--;
						return true;
					}
					return false;
				},
				right: () => {
					if (!isNetworkRow && !isTopRow) return false;
					let maxIndex = 4; // top row: 5 buttons (0-4)
					if (isNetworkRow) {
						const networkIndex = selectedIndex - 1;
						const isFirst = networkIndex === 0;
						const isLast = networkIndex === networks.length - 1;
						// 5 base buttons + up (if not first) + down (if not last)
						maxIndex = 4 + (isFirst ? 0 : 1) + (isLast ? 0 : 1);
					}
					if (buttonIndex < maxIndex) {
						buttonIndex++;
						return true;
					}
					return false;
				},
				confirmDown: () => {},
				confirmUp: () => {
					if (selectedIndex === 0) {
						if (buttonIndex === 0) onBack?.();
						else if (buttonIndex === 1) openPublic();
						else if (buttonIndex === 2) openAddNetwork();
						else if (buttonIndex === 3) openImport();
						else openExportAll();
					} else {
						const networkIndex = selectedIndex - 1;
						const network = networks[networkIndex];
						if (network) {
							const isFirst = networkIndex === 0;
							const isLast = networkIndex === networks.length - 1;
							if (buttonIndex === 0) connectNetwork(network);
							else if (buttonIndex === 1) openPeers(network);
							else if (buttonIndex === 2) openExport(network);
							else if (buttonIndex === 3) openEditNetwork(network);
							else if (buttonIndex === 4) deleteNetwork(network);
							else if (buttonIndex === 5 && !isFirst) moveNetwork(networkIndex, true);
							else if (buttonIndex === 5 && isFirst && !isLast) moveNetwork(networkIndex, false);
							else if (buttonIndex === 6) moveNetwork(networkIndex, false);
						}
					}
				},
				confirmCancel: () => {},
				back: () => onBack?.(),
			},
			position
		);
	}

	// Re-register handler when showAddEdit changes back to false
	onMount(() => {
		loadNetworks().then(() => {
			unregisterArea = registerAreaHandler();
			activateArea(areaID);
		});
		return () => {
			if (unregisterArea) unregisterArea();
		};
	});
</script>

<style>
	.lish-network-list {
		display: flex;
		flex-direction: column;
		align-items: center;
		flex: 1;
		min-height: 0;
		padding: 2vh;
		gap: 2vh;
		overflow-y: auto;
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		width: 1200px;
		max-width: 100%;
	}

	.top-buttons {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-start;
		gap: 1vh;
		margin-bottom: 1vh;
	}

	.back {
		margin-top: 2vh;
	}

	.global-node-info {
		font-size: 1.6vh;
		color: var(--disabled-foreground);
		font-family: monospace;
		word-break: break-all;
		white-space: pre-wrap;
		padding: 1vh;
		margin-bottom: 1vh;
	}

	.network {
		display: flex;
		flex-direction: column;
		gap: 2vh;
	}

	.network .name {
		font-size: 2.5vh;
		font-weight: bold;
		color: var(--primary-foreground);
	}

	.network .description {
		font-size: 1.6vh;
		color: var(--disabled-foreground);
	}

	.network .buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 1vh;
	}
</style>

{#if showAddEdit}
	{@const networkForEdit = editingNetwork ? { id: editingNetwork.networkID, name: editingNetwork.name, description: editingNetwork.description, bootstrapServers: editingNetwork.bootstrapPeers.length > 0 ? editingNetwork.bootstrapPeers : [''] } : null}
	<LISHNetworkAddEdit {areaID} {position} network={networkForEdit} onBack={handleAddEditBack} onSave={handleSave} />
{:else if showExport}
	<LISHNetworkExport {areaID} {position} network={exportingNetwork ? { id: exportingNetwork.networkID, name: exportingNetwork.name } : null} onBack={handleExportBack} />
{:else if showExportAll}
	<LISHNetworkExportAll {areaID} {position} onBack={handleExportAllBack} />
{:else if showPublic}
	<LISHNetworkPublic {areaID} {position} onBack={handlePublicBack} />
{:else if showPeers && peersNetwork}
	<LISHNetworkPeers {areaID} {position} network={peersNetwork} onBack={handlePeersBack} />
{:else if showDeleteConfirm && deletingNetwork}
	<ConfirmDialog title={$t('common.delete')} message={$t('settings.lishNetwork.confirmDelete', { name: deletingNetwork.name })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmDeleteNetwork} onBack={cancelDelete} />
{:else}
	<div class="lish-network-list">
		<div class="container">
			<div class="top-buttons" bind:this={rowElements[0]}>
				<Button icon="/img/back.svg" label={$t('common.back')} selected={active && selectedIndex === 0 && buttonIndex === 0} onConfirm={onBack} />
				<Button icon="/img/online.svg" label={$t('settings.lishNetwork.publicList')} selected={active && selectedIndex === 0 && buttonIndex === 1} onConfirm={openPublic} />
				<Button icon="/img/plus.svg" label={$t('common.add')} selected={active && selectedIndex === 0 && buttonIndex === 2} onConfirm={openAddNetwork} />
				<Button icon="/img/import.svg" label={$t('common.import')} selected={active && selectedIndex === 0 && buttonIndex === 3} onConfirm={openImport} />
				<Button icon="/img/export.svg" label={$t('common.exportAll')} selected={active && selectedIndex === 0 && buttonIndex === 4} onConfirm={openExportAll} />
			</div>
			{#if globalNodeInfo}
				<div class="global-node-info">{JSON.stringify(globalNodeInfo, null, 2)}</div>
			{/if}
			{#if networks.length === 0}
				<Alert type="warning" message={$t('settings.lishNetwork.emptyList')} />
			{:else}
				{#each networks as network, i}
					{@const isFirst = i === 0}
					{@const isLast = i === networks.length - 1}
					{@const upButtonIndex = 5}
					{@const downButtonIndex = isFirst ? 5 : 6}
					<div bind:this={rowElements[i + 1]}>
						<Row selected={active && selectedIndex === i + 1}>
							<div class="network">
								<div class="name">{network.name}</div>
								{#if network.description}
									<div class="description">{@html network.description.replaceAll('\n', '<br />')}</div>
								{/if}
								{#if networkErrors[network.networkID]}
									<Alert type="error" message={networkErrors[network.networkID]} />
								{/if}
								<div class="buttons">
									<Button icon="/img/connect.svg" label={network.enabled ? $t('common.disconnect') : $t('common.connect')} active={network.enabled} selected={active && selectedIndex === i + 1 && buttonIndex === 0} onConfirm={() => connectNetwork(network)} />
									<Button icon="/img/online.svg" label={$t('settings.lishNetwork.peerList')} selected={active && selectedIndex === i + 1 && buttonIndex === 1} onConfirm={() => openPeers(network)} />
									<Button icon="/img/export.svg" label={$t('common.export')} selected={active && selectedIndex === i + 1 && buttonIndex === 2} onConfirm={() => openExport(network)} />
									<Button icon="/img/edit.svg" label={$t('common.edit')} selected={active && selectedIndex === i + 1 && buttonIndex === 3} onConfirm={() => openEditNetwork(network)} />
									<Button icon="/img/del.svg" label={$t('common.delete')} selected={active && selectedIndex === i + 1 && buttonIndex === 4} onConfirm={() => deleteNetwork(network)} />
									{#if !isFirst}
										<Button icon="/img/up.svg" selected={active && selectedIndex === i + 1 && buttonIndex === upButtonIndex} onConfirm={() => moveNetwork(i, true)} padding="1vh" fontSize="4vh" width="auto" />
									{/if}
									{#if !isLast}
										<Button icon="/img/down.svg" selected={active && selectedIndex === i + 1 && buttonIndex === downButtonIndex} onConfirm={() => moveNetwork(i, false)} padding="1vh" fontSize="4vh" width="auto" />
									{/if}
								</div>
							</div>
						</Row>
					</div>
				{/each}
			{/if}
		</div>
	</div>
{/if}
