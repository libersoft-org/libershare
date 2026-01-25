<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, setAreaPosition, removeArea, activateArea } from '../../scripts/areas.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { type LISHNetwork, getNetworks, saveNetworks as saveNetworksToStorage } from '../../scripts/lishnet.ts';
	import Button from '../Buttons/Button.svelte';
	import Alert from '../Alert/Alert.svelte';
	import ConfirmDialog from '../Dialog/ConfirmDialog.svelte';
	import Row from '../Row/Row.svelte';
	import LISHNetworkAddEdit from './SettingsLISHNetworkAddEdit.svelte';
	import LISHNetworkExport from './SettingsLISHNetworkExport.svelte';
	import LISHNetworkExportAll from './SettingsLISHNetworkExportAll.svelte';
	import LISHNetworkImport from './SettingsLISHNetworkImport.svelte';
	import LISHNetworkPublic from './SettingsLISHNetworkPublic.svelte';
	interface Props {
		areaID: string;
		onBack?: () => void;
	}
	let { areaID, onBack }: Props = $props();
	const editAreaID = areaID + '-edit';
	const exportAreaID = areaID + '-export';
	const exportAllAreaID = areaID + '-export-all';
	const importAreaID = areaID + '-import';
	const publicAreaID = areaID + '-public';
	let removeBackHandler: (() => void) | null = null;
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0);
	let buttonIndex = $state(0); // 0 = Add, 1 = Import (for top row); 0 = Connect, 1 = Edit, 2 = Delete (for network rows)
	let showAddEdit = $state(false);
	let showExport = $state(false);
	let showExportAll = $state(false);
	let showImport = $state(false);
	let showPublic = $state(false);
	let editingNetwork = $state<LISHNetwork | null>(null);
	let exportingNetwork = $state<LISHNetwork | null>(null);
	let deletingNetwork = $state<LISHNetwork | null>(null);
	let rowElements: HTMLElement[] = $state([]);
	// Load networks from localStorage
	let networks = $state<LISHNetwork[]>(getNetworks());

	function saveNetworks() {
		saveNetworksToStorage(networks);
	}

	// Items: Top buttons row (0), network rows (1 to networks.length), Back button (last)
	let totalItems = $derived(networks.length + 2);

	// Check if current row is the top row (has Add/Import buttons)
	let isTopRow = $derived(selectedIndex === 0);

	// Check if current row is a network row (has Edit/Delete buttons)
	let isNetworkRow = $derived(selectedIndex > 0 && selectedIndex < totalItems - 1);

	function openPublic() {
		showPublic = true;
		setAreaPosition(areaID, { x: -999, y: -999 });
		setAreaPosition(publicAreaID, { x: 0, y: 2 });
		pushBreadcrumb($t.settings?.lishNetwork?.publicList);
		removeBackHandler = pushBackHandler(handlePublicBack);
	}

	function handlePublicBack() {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		removeArea(publicAreaID);
		setAreaPosition(areaID, { x: 0, y: 2 });
		popBreadcrumb();
		showPublic = false;
		// Reload networks in case new ones were added
		networks = getNetworks();
		registerAreaHandler();
		activateArea(areaID);
	}

	function openAddNetwork() {
		editingNetwork = null;
		showAddEdit = true;
		setAreaPosition(areaID, { x: -999, y: -999 }); // Move original area out of the way
		setAreaPosition(editAreaID, { x: 0, y: 2 });
		pushBreadcrumb($t.common?.add);
		removeBackHandler = pushBackHandler(handleAddEditBack);
	}

	function openImport() {
		showImport = true;
		setAreaPosition(areaID, { x: -999, y: -999 }); // Move original area out of the way
		setAreaPosition(importAreaID, { x: 0, y: 2 });
		pushBreadcrumb($t.common?.import);
		removeBackHandler = pushBackHandler(handleImportBack);
	}

	function handleImportBack() {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		removeArea(importAreaID);
		setAreaPosition(areaID, { x: 0, y: 2 }); // Restore original area position
		popBreadcrumb();
		showImport = false;
		registerAreaHandler();
		activateArea(areaID);
	}

	function handleImport() {
		// Reload networks from localStorage and go back to list
		networks = getNetworks();
		handleImportBack();
	}

	function openExportAll() {
		showExportAll = true;
		setAreaPosition(areaID, { x: -999, y: -999 });
		setAreaPosition(exportAllAreaID, { x: 0, y: 2 });
		pushBreadcrumb($t.common?.exportAll);
		removeBackHandler = pushBackHandler(handleExportAllBack);
	}

	function handleExportAllBack() {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		removeArea(exportAllAreaID);
		setAreaPosition(areaID, { x: 0, y: 2 });
		popBreadcrumb();
		showExportAll = false;
		registerAreaHandler();
		activateArea(areaID);
	}

	function connectNetwork(network: LISHNetwork) {
		// TODO: Implement actual connection logic
		console.log('Connecting to network:', network.name);
	}

	function openExport(network: LISHNetwork) {
		exportingNetwork = network;
		showExport = true;
		setAreaPosition(areaID, { x: -999, y: -999 });
		setAreaPosition(exportAreaID, { x: 0, y: 2 });
		pushBreadcrumb(`${network.name} - ${$t.common?.export}`);
		removeBackHandler = pushBackHandler(handleExportBack);
	}

	function handleExportBack() {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		removeArea(exportAreaID);
		setAreaPosition(areaID, { x: 0, y: 2 });
		popBreadcrumb();
		showExport = false;
		exportingNetwork = null;
		registerAreaHandler();
		activateArea(areaID);
	}

	function openEditNetwork(network: LISHNetwork) {
		editingNetwork = network;
		showAddEdit = true;
		setAreaPosition(areaID, { x: -999, y: -999 }); // Move original area out of the way
		setAreaPosition(editAreaID, { x: 0, y: 2 });
		pushBreadcrumb(`${network.name} - ${$t.common?.edit}`);
		removeBackHandler = pushBackHandler(handleAddEditBack);
	}

	function deleteNetwork(network: LISHNetwork) {
		deletingNetwork = network;
		setAreaPosition(areaID, { x: -999, y: -999 }); // Move list area out of the way for dialog
	}

	function confirmDeleteNetwork() {
		if (deletingNetwork) {
			networks = networks.filter(n => n.networkID !== deletingNetwork!.networkID);
			saveNetworks();
			// Adjust selected index if needed
			if (selectedIndex >= totalItems) selectedIndex = totalItems - 1;
			buttonIndex = 0;
			deletingNetwork = null;
			setAreaPosition(areaID, { x: 0, y: 2 }); // Restore list area
			activateArea(areaID);
		}
	}

	function cancelDelete() {
		deletingNetwork = null;
		setAreaPosition(areaID, { x: 0, y: 2 }); // Restore list area
		activateArea(areaID);
	}

	function handleAddEditBack() {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		removeArea(editAreaID);
		setAreaPosition(areaID, { x: 0, y: 2 }); // Restore original area position
		popBreadcrumb();
		showAddEdit = false;
		editingNetwork = null;
		registerAreaHandler();
		activateArea(areaID);
	}

	function handleSave(savedNetwork: { id: string; name: string; description: string; bootstrapServers: string[] }) {
		const network: LISHNetwork = {
			version: 1,
			networkID: savedNetwork.id,
			name: savedNetwork.name,
			description: savedNetwork.description,
			bootstrapPeers: savedNetwork.bootstrapServers,
			created: editingNetwork?.created || new Date().toISOString(),
		};
		if (editingNetwork) {
			// Update existing
			const index = networks.findIndex(n => n.networkID === editingNetwork!.networkID);
			if (index !== -1) networks[index] = network;
		} else {
			// Add new
			networks = [...networks, network];
		}
		saveNetworks();
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		removeArea(editAreaID);
		setAreaPosition(areaID, { x: 0, y: 2 }); // Restore original area position
		popBreadcrumb();
		showAddEdit = false;
		editingNetwork = null;
		registerAreaHandler();
		activateArea(areaID);
	}

	function scrollToSelected(): void {
		const element = rowElements[selectedIndex];
		if (element) {
			element.scrollIntoView({
				behavior: 'smooth',
				block: 'center',
			});
		}
	}

	function registerAreaHandler() {
		return useArea(areaID, {
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
				const maxIndex = isTopRow ? 3 : isNetworkRow ? 3 : 0;
				if (buttonIndex < maxIndex) {
					buttonIndex++;
					return true;
				}
				return false;
			},
			confirmDown: () => {},
			confirmUp: () => {
				if (selectedIndex === 0) {
					if (buttonIndex === 0) openPublic();
					else if (buttonIndex === 1) openAddNetwork();
					else if (buttonIndex === 2) openImport();
					else openExportAll();
				} else if (selectedIndex === totalItems - 1) onBack?.();
				else {
					const networkIndex = selectedIndex - 1;
					const network = networks[networkIndex];
					if (network) {
						if (buttonIndex === 0) connectNetwork(network);
						else if (buttonIndex === 1) openExport(network);
						else if (buttonIndex === 2) openEditNetwork(network);
						else deleteNetwork(network);
					}
				}
			},
			confirmCancel: () => {},
			back: () => onBack?.(),
		});
	}

	// Re-register handler when showAddEdit changes back to false
	onMount(() => {
		return registerAreaHandler();
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
		justify-content: flex-start;
		gap: 1vh;
		margin-bottom: 1vh;
	}

	.back {
		margin-top: 2vh;
	}

	.network {
		display: flex;
		flex-direction: column;
		gap: 2vh;
	}

	.network .name {
		font-size: 2.5vh;
		font-weight: bold;
		color: var(--secondary-foreground);
	}

	.network .buttons {
		display: flex;
		gap: 1vh;
	}
</style>

{#if showAddEdit}
	{@const networkForEdit = editingNetwork ? { id: editingNetwork.networkID, name: editingNetwork.name, description: editingNetwork.description, bootstrapServers: editingNetwork.bootstrapPeers } : null}
	<LISHNetworkAddEdit areaID={editAreaID} network={networkForEdit} onBack={handleAddEditBack} onSave={handleSave} />
{:else if showExport}
	<LISHNetworkExport areaID={exportAreaID} network={exportingNetwork ? { id: exportingNetwork.networkID, name: exportingNetwork.name } : null} onBack={handleExportBack} />
{:else if showExportAll}
	<LISHNetworkExportAll areaID={exportAllAreaID} onBack={handleExportAllBack} />
{:else if showImport}
	<LISHNetworkImport areaID={importAreaID} onBack={handleImportBack} onImport={handleImport} />
{:else if showPublic}
	<LISHNetworkPublic areaID={publicAreaID} onBack={handlePublicBack} />
{:else}
	<div class="lish-network-list">
		<div class="container">
			<div class="top-buttons" bind:this={rowElements[0]}>
				<Button label={$t.settings?.lishNetwork?.publicList} selected={active && selectedIndex === 0 && buttonIndex === 0} onConfirm={openPublic} />
				<Button label={$t.common?.add} selected={active && selectedIndex === 0 && buttonIndex === 1} onConfirm={openAddNetwork} />
				<Button icon="/img/import.svg" label={$t.common?.import} selected={active && selectedIndex === 0 && buttonIndex === 2} onConfirm={openImport} />
				<Button icon="/img/export.svg" label={$t.common?.exportAll} selected={active && selectedIndex === 0 && buttonIndex === 3} onConfirm={openExportAll} />
			</div>
			{#if networks.length === 0}
				<Alert type="warning" message={$t.settings?.lishNetwork?.emptyList} />
			{:else}
				{#each networks as network, i}
					<div bind:this={rowElements[i + 1]}>
						<Row selected={active && selectedIndex === i + 1}>
							<div class="network">
								<div class="name">{network.name}</div>
								<div class="buttons">
									<Button label={$t.common?.connect} selected={active && selectedIndex === i + 1 && buttonIndex === 0} onConfirm={() => connectNetwork(network)} />
									<Button icon="/img/export.svg" label={$t.common?.export} selected={active && selectedIndex === i + 1 && buttonIndex === 1} onConfirm={() => openExport(network)} />
									<Button label={$t.common?.edit} selected={active && selectedIndex === i + 1 && buttonIndex === 2} onConfirm={() => openEditNetwork(network)} />
									<Button label={$t.common?.delete} selected={active && selectedIndex === i + 1 && buttonIndex === 3} onConfirm={() => deleteNetwork(network)} />
								</div>
							</div>
						</Row>
					</div>
				{/each}
			{/if}
		</div>
		<div class="back" bind:this={rowElements[totalItems - 1]}>
			<Button label={$t.common?.back} selected={active && selectedIndex === totalItems - 1} onConfirm={onBack} />
		</div>
	</div>
{/if}

{#if deletingNetwork}
	<ConfirmDialog title={$t.common?.delete} message={$t.settings?.lishNetwork?.confirmDelete?.replace('{name}', deletingNetwork.name)} confirmLabel={$t.common?.yes} cancelLabel={$t.common?.no} defaultButton="cancel" onConfirm={confirmDeleteNetwork} onBack={cancelDelete} />
{/if}
