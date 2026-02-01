<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb, navigateTo } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { type LISHNetwork, getNetworks, saveNetworks as saveNetworksToStorage, deleteNetwork as deleteNetworkFromStorage, formDataToNetwork, type NetworkFormData } from '../../scripts/lishNetwork.ts';
	import { scrollToElement } from '../../scripts/utils.ts';
	import Button from '../../components/Buttons/Button.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	import Row from '../../components/Row/Row.svelte';
	import LISHNetworkAddEdit from './SettingsLISHNetworkAddEdit.svelte';
	import LISHNetworkExport from './SettingsLISHNetworkExport.svelte';
	import LISHNetworkExportAll from './SettingsLISHNetworkExportAll.svelte';
	import LISHNetworkPublic from './SettingsLISHNetworkPublic.svelte';
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
		networks = getNetworks();
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

	function connectNetwork(network: LISHNetwork) {
		// TODO: Implement actual connection logic
		console.log('Connecting to network:', network.name);
	}

	function moveNetwork(index: number, up: boolean) {
		const newIndex = up ? index - 1 : index + 1;
		if (newIndex < 0 || newIndex >= networks.length) return;
		const temp = networks[index];
		networks[index] = networks[newIndex];
		networks[newIndex] = temp;
		networks = [...networks]; // Trigger reactivity
		saveNetworks();
		// Move selection with the item
		selectedIndex += up ? -1 : 1;
		// Adjust buttonIndex if moved to first/last position where some buttons don't exist
		const isNowFirst = newIndex === 0;
		const isNowLast = newIndex === networks.length - 1;
		// First item has max 5 buttons (0-4), last item has max 5 buttons (0-4), middle has 6 (0-5)
		const maxButtonIndex = isNowFirst || isNowLast ? 4 : 5;
		if (buttonIndex > maxButtonIndex) buttonIndex = maxButtonIndex;
	}

	function openExport(network: LISHNetwork) {
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

	function openEditNetwork(network: LISHNetwork) {
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

	function deleteNetwork(network: LISHNetwork) {
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
			networks = networks.filter(n => n.networkID !== deletingNetwork!.networkID);
			saveNetworks();
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
					let maxIndex = 3; // top row: 4 buttons (0-3)
					if (isNetworkRow) {
						const networkIndex = selectedIndex - 1;
						const isFirst = networkIndex === 0;
						const isLast = networkIndex === networks.length - 1;
						// 4 base buttons + up (if not first) + down (if not last)
						maxIndex = 3 + (isFirst ? 0 : 1) + (isLast ? 0 : 1);
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
						if (buttonIndex === 0) openPublic();
						else if (buttonIndex === 1) openAddNetwork();
						else if (buttonIndex === 2) openImport();
						else openExportAll();
					} else if (selectedIndex === totalItems - 1) onBack?.();
					else {
						const networkIndex = selectedIndex - 1;
						const network = networks[networkIndex];
						if (network) {
							const isFirst = networkIndex === 0;
							const isLast = networkIndex === networks.length - 1;
							if (buttonIndex === 0) connectNetwork(network);
							else if (buttonIndex === 1) openExport(network);
							else if (buttonIndex === 2) openEditNetwork(network);
							else if (buttonIndex === 3) deleteNetwork(network);
							else if (buttonIndex === 4 && !isFirst) moveNetwork(networkIndex, true);
							else if (buttonIndex === 4 && isFirst && !isLast) moveNetwork(networkIndex, false);
							else if (buttonIndex === 5) moveNetwork(networkIndex, false);
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
		unregisterArea = registerAreaHandler();
		activateArea(areaID);
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
	{@const networkForEdit = editingNetwork ? { id: editingNetwork.networkID, name: editingNetwork.name, description: editingNetwork.description, bootstrapServers: editingNetwork.bootstrapPeers.length > 0 ? editingNetwork.bootstrapPeers : [''] } : null}
	<LISHNetworkAddEdit {areaID} {position} network={networkForEdit} onBack={handleAddEditBack} onSave={handleSave} />
{:else if showExport}
	<LISHNetworkExport {areaID} {position} network={exportingNetwork ? { id: exportingNetwork.networkID, name: exportingNetwork.name } : null} onBack={handleExportBack} />
{:else if showExportAll}
	<LISHNetworkExportAll {areaID} {position} onBack={handleExportAllBack} />
{:else if showPublic}
	<LISHNetworkPublic {areaID} {position} onBack={handlePublicBack} />
{:else if showDeleteConfirm && deletingNetwork}
	<ConfirmDialog title={$t('common.delete')} message={$t('settings.lishNetwork.confirmDelete').replace('{name}', deletingNetwork.name)} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmDeleteNetwork} onBack={cancelDelete} />
{:else}
	<div class="lish-network-list">
		<div class="container">
			<div class="top-buttons" bind:this={rowElements[0]}>
				<Button icon="/img/online.svg" label={$t('settings.lishNetwork.publicList')} selected={active && selectedIndex === 0 && buttonIndex === 0} onConfirm={openPublic} />
				<Button icon="/img/plus.svg" label={$t('common.add')} selected={active && selectedIndex === 0 && buttonIndex === 1} onConfirm={openAddNetwork} />
				<Button icon="/img/import.svg" label={$t('common.import')} selected={active && selectedIndex === 0 && buttonIndex === 2} onConfirm={openImport} />
				<Button icon="/img/export.svg" label={$t('common.exportAll')} selected={active && selectedIndex === 0 && buttonIndex === 3} onConfirm={openExportAll} />
			</div>
			{#if networks.length === 0}
				<Alert type="warning" message={$t('settings.lishNetwork.emptyList')} />
			{:else}
				{#each networks as network, i}
					{@const isFirst = i === 0}
					{@const isLast = i === networks.length - 1}
					{@const upButtonIndex = 4}
					{@const downButtonIndex = isFirst ? 4 : 5}
					<div bind:this={rowElements[i + 1]}>
						<Row selected={active && selectedIndex === i + 1}>
							<div class="network">
								<div class="name">{network.name}</div>
								<div class="buttons">
									<Button icon="/img/connect.svg" label={$t('common.connect')} selected={active && selectedIndex === i + 1 && buttonIndex === 0} onConfirm={() => connectNetwork(network)} />
									<Button icon="/img/export.svg" label={$t('common.export')} selected={active && selectedIndex === i + 1 && buttonIndex === 1} onConfirm={() => openExport(network)} />
									<Button icon="/img/edit.svg" label={$t('common.edit')} selected={active && selectedIndex === i + 1 && buttonIndex === 2} onConfirm={() => openEditNetwork(network)} />
									<Button icon="/img/del.svg" label={$t('common.delete')} selected={active && selectedIndex === i + 1 && buttonIndex === 3} onConfirm={() => deleteNetwork(network)} />
									{#if !isFirst}
										<Button icon="/img/up.svg" selected={active && selectedIndex === i + 1 && buttonIndex === upButtonIndex} onConfirm={() => moveNetwork(i, true)} />
									{/if}
									{#if !isLast}
										<Button icon="/img/down.svg" selected={active && selectedIndex === i + 1 && buttonIndex === downButtonIndex} onConfirm={() => moveNetwork(i, false)} />
									{/if}
								</div>
							</div>
						</Row>
					</div>
				{/each}
			{/if}
		</div>
		<div class="back" bind:this={rowElements[totalItems - 1]}>
			<Button icon="/img/back.svg" label={$t('common.back')} selected={active && selectedIndex === totalItems - 1} onConfirm={onBack} />
		</div>
	</div>
{/if}
