<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { pushBreadcrumb, popBreadcrumb, navigateTo } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { type LISHNetworkConfig, type NetworkNodeInfo } from '@shared';
	import { api } from '../../scripts/api.ts';
	import { getNetworks, deleteNetwork as deleteNetworkFromAPI, updateNetwork as updateNetworkFromAPI, addNetwork as addNetworkFromAPI, formDataToNetwork, type NetworkFormData } from '../../scripts/lishNetwork.ts';
	import { scrollToElement } from '../../scripts/utils.ts';
	import { peerCounts, subscribePeerCounts, unsubscribePeerCounts } from '../../scripts/networks.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	import Row from '../../components/Row/Row.svelte';
	import Table from '../../components/Table/Table.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	import LISHNetworkAddEdit from './SettingsLISHNetworkAddEdit.svelte';
	import LISHNetworkExport from './SettingsLISHNetworkExport.svelte';
	import LISHNetworkExportAll from './SettingsLISHNetworkExportAll.svelte';
	import LISHNetworkPublic from './SettingsLISHNetworkPublic.svelte';
	import LISHNetworkPeers from './SettingsLISHNetworkPeers.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
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
	let showAddresses = $state(false);
	let editingNetwork = $state<LISHNetworkConfig | null>(null);
	let exportingNetwork = $state<LISHNetworkConfig | null>(null);
	let deletingNetwork = $state<LISHNetworkConfig | null>(null);
	let peersNetwork = $state<LISHNetworkConfig | null>(null);
	let rowElements: HTMLElement[] = $state([]);
	// Networks loaded from backend
	let networks = $state<LISHNetworkConfig[]>([]);
	let globalNodeInfo = $state<NetworkNodeInfo | null>(null);
	let networkErrors = $state<Record<string, string>>({});

	async function loadNetworks(): Promise<void> {
		const [nets, nodeInfo] = await Promise.all([getNetworks(), api.lishnets.getNodeInfo().catch((): null => null)]);
		globalNodeInfo = nodeInfo;
		networks = nets;
	}

	// Items: Top buttons row (0), node info row (1, if globalNodeInfo), network rows
	let nodeInfoOffset = $derived(globalNodeInfo ? 1 : 0);
	let totalItems = $derived(networks.length + 1 + nodeInfoOffset);
	// Check if current row is the top row (has Back/Add/Import buttons)
	let isTopRow = $derived(selectedIndex === 0);
	// Check if current row is the node info row
	let isNodeInfoRow = $derived(globalNodeInfo !== null && selectedIndex === 1);
	// Check if current row is a network row (has Edit/Delete buttons)
	let isNetworkRow = $derived(selectedIndex >= 1 + nodeInfoOffset && selectedIndex < totalItems);

	function openPublic(): void {
		showPublic = true;
		// Unregister our area - sub-component will create its own
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb($t('settings.lishNetwork.publicList'));
		removeBackHandler = pushBackHandler(handlePublicBack);
	}

	async function handlePublicBack(): Promise<void> {
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

	function openAddNetwork(): void {
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

	function openImport(): void {
		navigateTo('import-lishnet');
	}

	function openExportAll(): void {
		showExportAll = true;
		// Unregister our area - sub-component will create its own
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb($t('common.exportAll'));
		removeBackHandler = pushBackHandler(handleExportAllBack);
	}

	async function handleExportAllBack(): Promise<void> {
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

	async function connectNetwork(network: LISHNetworkConfig): Promise<void> {
		// Toggle enabled state
		const newEnabled = !network.enabled;
		network.enabled = newEnabled;
		networks = [...networks]; // Trigger reactivity
		// Clear previous error for this network
		const { [network.networkID]: _err, ...restErrors } = networkErrors;
		networkErrors = restErrors;
		try {
			await api.lishnets.setEnabled(network.networkID, newEnabled);
		} catch (e: any) {
			networkErrors = { ...networkErrors, [network.networkID]: e?.message || 'Connection failed' };
		}
	}

	async function moveNetwork(index: number, up: boolean): Promise<void> {
		const newIndex = up ? index - 1 : index + 1;
		if (newIndex < 0 || newIndex >= networks.length) return;
		const temp = networks[index]!;
		networks[index] = networks[newIndex]!;
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
		await api.lishnets.replace(networks);
	}

	function openPeers(network: LISHNetworkConfig): void {
		peersNetwork = network;
		showPeers = true;
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb(`${network.name} - ${$t('settings.lishNetwork.peerList')}`);
		removeBackHandler = pushBackHandler(handlePeersBack);
	}

	async function handlePeersBack(): Promise<void> {
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

	function openExport(network: LISHNetworkConfig): void {
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

	async function handleExportBack(): Promise<void> {
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

	function openEditNetwork(network: LISHNetworkConfig): void {
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

	function deleteNetwork(network: LISHNetworkConfig): void {
		deletingNetwork = network;
		showDeleteConfirm = true;
		// Unregister our area - ConfirmDialog will create its own
		if (unregisterArea) {
			unregisterArea();
			unregisterArea = null;
		}
		pushBreadcrumb(`${network.name} - ${$t('common.delete')}`);
	}

	async function confirmDeleteNetwork(): Promise<void> {
		if (deletingNetwork) {
			await deleteNetworkFromAPI(deletingNetwork.networkID);
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

	async function cancelDelete(): Promise<void> {
		deletingNetwork = null;
		showDeleteConfirm = false;
		popBreadcrumb();
		// Wait for sub-component to unmount before re-registering
		await tick();
		unregisterArea = registerAreaHandler();
		activateArea(areaID);
	}

	async function handleAddEditBack(): Promise<void> {
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

	async function handleSave(savedNetwork: NetworkFormData): Promise<void> {
		const network = formDataToNetwork(savedNetwork, editingNetwork ?? undefined);
		if (editingNetwork) {
			// Update existing
			await updateNetworkFromAPI(network);
			const index = networks.findIndex(n => n.networkID === editingNetwork!.networkID);
			if (index !== -1) networks[index] = network;
		} else {
			// Add new - backend generates networkID and key if empty
			await addNetworkFromAPI(network);
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

	function scrollToSelected(): void {
		scrollToElement(rowElements, selectedIndex);
	}

	function registerAreaHandler(): () => void {
		return useArea(
			areaID,
			{
				up() {
					if (selectedIndex > 0) {
						selectedIndex--;
						buttonIndex = 0;
						scrollToSelected();
						return true;
					}
					return false;
				},
				down() {
					if (selectedIndex < totalItems - 1) {
						selectedIndex++;
						buttonIndex = 0;
						scrollToSelected();
						return true;
					}
					return false;
				},
				left() {
					if ((isTopRow || isNetworkRow) && buttonIndex > 0) {
						buttonIndex--;
						return true;
					}
					return false;
				},
				right() {
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
				confirmDown() {},
				confirmUp() {
					if (selectedIndex === 0) {
						if (buttonIndex === 0) onBack?.();
						else if (buttonIndex === 1) openPublic();
						else if (buttonIndex === 2) openAddNetwork();
						else if (buttonIndex === 3) openImport();
						else openExportAll();
					} else if (isNodeInfoRow) {
						showAddresses = !showAddresses;
					} else {
						const networkIndex = selectedIndex - 1 - nodeInfoOffset;
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
				confirmCancel() {},
				back() {
					onBack?.();
				},
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
		subscribePeerCounts();
		return () => {
			if (unregisterArea) unregisterArea();
			unsubscribePeerCounts();
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

	.node-info {
		display: flex;
		flex-direction: column;
		gap: 1.5vh;
	}

	.node-info .peer-id {
		font-size: 1.8vh;
		word-break: break-all;
	}

	.node-info .peer-id .label {
		color: var(--disabled-foreground);
	}

	.node-info .peer-id .value {
		font-family: monospace;
		color: var(--primary-foreground);
	}

	.node-info .buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 1vh;
	}

	.node-info .address-index {
		font-size: 1.5vh;
		font-family: monospace;
		color: var(--disabled-foreground);
	}

	.node-info .address-value {
		font-size: 1.5vh;
		font-family: monospace;
		color: var(--disabled-foreground);
		word-break: break-all;
	}

	.network {
		display: flex;
		flex-direction: column;
		gap: 2vh;
	}

	.network .header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 2vh;
	}

	.network .name {
		font-size: 2.5vh;
		font-weight: bold;
		color: var(--primary-foreground);
	}

	.network .peer-count {
		padding: 1vh;
		border-radius: 1vh;
		font-size: 2vh;
		font-weight: bold;
		background-color: var(--primary-foreground);
		color: var(--primary-background);
		white-space: nowrap;
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
			<div bind:this={rowElements[0]}>
				<ButtonBar>
					<Button icon="/img/back.svg" label={$t('common.back')} selected={active && selectedIndex === 0 && buttonIndex === 0} onConfirm={onBack} />
					<Button icon="/img/online.svg" label={$t('settings.lishNetwork.publicList')} selected={active && selectedIndex === 0 && buttonIndex === 1} onConfirm={openPublic} />
					<Button icon="/img/plus.svg" label={$t('common.add')} selected={active && selectedIndex === 0 && buttonIndex === 2} onConfirm={openAddNetwork} />
					<Button icon="/img/import.svg" label={$t('common.import')} selected={active && selectedIndex === 0 && buttonIndex === 3} onConfirm={openImport} />
					<Button icon="/img/export.svg" label={$t('common.exportAll')} selected={active && selectedIndex === 0 && buttonIndex === 4} onConfirm={openExportAll} />
				</ButtonBar>
			</div>
			{#if globalNodeInfo}
				<div bind:this={rowElements[1]}>
					<Row selected={active && selectedIndex === 1}>
						<div class="node-info">
							<div class="peer-id"><span class="label">{$t('settings.lishNetwork.yourPeerID')}:</span> <span class="value">{globalNodeInfo.peerID}</span></div>
							<div class="buttons">
								<Button
									icon={showAddresses ? '/img/up.svg' : '/img/down.svg'}
									label={showAddresses ? $t('common.hide') + ' ' + $t('settings.lishNetwork.addresses') : $t('common.show') + ' ' + $t('settings.lishNetwork.addresses')}
									selected={active && selectedIndex === 1 && buttonIndex === 0}
									onConfirm={() => {
										showAddresses = !showAddresses;
									}}
								/>
							</div>
							{#if showAddresses && globalNodeInfo.addresses.length > 0}
								<Table columns="auto 1fr">
									{#each globalNodeInfo.addresses as address, i}
										<TableRow odd={i % 2 === 0}>
											<TableCell><span class="address-index">{i + 1}.</span></TableCell>
											<TableCell wrap><span class="address-value">{address}</span></TableCell>
										</TableRow>
									{/each}
								</Table>
							{/if}
						</div>
					</Row>
				</div>
			{/if}
			{#if networks.length === 0}
				<Alert type="warning" message={$t('settings.lishNetwork.emptyList')} />
			{:else}
				{#each networks as network, i}
					{@const isFirst = i === 0}
					{@const isLast = i === networks.length - 1}
					{@const upButtonIndex = 5}
					{@const downButtonIndex = isFirst ? 5 : 6}
					<div bind:this={rowElements[i + 1 + nodeInfoOffset]}>
						<Row selected={active && selectedIndex === i + 1 + nodeInfoOffset}>
							<div class="network">
								<div class="header">
									<div class="name">{network.name}</div>
									{#if network.enabled && $peerCounts[network.networkID] !== undefined}
										<div class="peer-count">{$t('settings.lishNetwork.connectedPeers', { count: String($peerCounts[network.networkID]!) })}</div>
									{/if}
								</div>
								{#if network.description}
									<div class="description">{@html network.description.replaceAll('\n', '<br />')}</div>
								{/if}
								{#if networkErrors[network.networkID]}
									<Alert type="error" message={networkErrors[network.networkID]!} />
								{/if}
								<div class="buttons">
									<Button icon="/img/connect.svg" label={network.enabled ? $t('common.disconnect') : $t('common.connect')} active={network.enabled} selected={active && selectedIndex === i + 1 + nodeInfoOffset && buttonIndex === 0} onConfirm={() => connectNetwork(network)} />
									<Button icon="/img/online.svg" label={$t('settings.lishNetwork.peerList')} selected={active && selectedIndex === i + 1 + nodeInfoOffset && buttonIndex === 1} onConfirm={() => openPeers(network)} />
									<Button icon="/img/export.svg" label={$t('common.export')} selected={active && selectedIndex === i + 1 + nodeInfoOffset && buttonIndex === 2} onConfirm={() => openExport(network)} />
									<Button icon="/img/edit.svg" label={$t('common.edit')} selected={active && selectedIndex === i + 1 + nodeInfoOffset && buttonIndex === 3} onConfirm={() => openEditNetwork(network)} />
									<Button icon="/img/del.svg" label={$t('common.delete')} selected={active && selectedIndex === i + 1 + nodeInfoOffset && buttonIndex === 4} onConfirm={() => deleteNetwork(network)} />
									{#if !isFirst}
										<Button icon="/img/up.svg" selected={active && selectedIndex === i + 1 + nodeInfoOffset && buttonIndex === upButtonIndex} onConfirm={() => moveNetwork(i, true)} padding="1vh" fontSize="4vh" width="auto" />
									{/if}
									{#if !isLast}
										<Button icon="/img/down.svg" selected={active && selectedIndex === i + 1 + nodeInfoOffset && buttonIndex === downButtonIndex} onConfirm={() => moveNetwork(i, false)} padding="1vh" fontSize="4vh" width="auto" />
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
