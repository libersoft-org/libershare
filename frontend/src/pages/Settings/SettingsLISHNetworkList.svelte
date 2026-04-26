<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { t, translateError, tt } from '../../scripts/language.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { pushBreadcrumb, popBreadcrumb, navigateTo } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { type LISHNetworkConfig, type NetworkNodeInfo } from '@shared';
	import { api } from '../../scripts/api.ts';
	import { getNetworks, deleteNetwork as deleteNetworkFromAPI, updateNetwork as updateNetworkFromAPI, addNetwork as addNetworkFromAPI, formDataToNetwork, type NetworkFormData } from '../../scripts/lishNetwork.ts';
	import { peerCounts, subscribePeerCounts, unsubscribePeerCounts } from '../../scripts/networks.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import ConfirmDialog from '../../components/Dialog/ConfirmDialog.svelte';
	import Row from '../../components/Row/Row.svelte';
	import LISHNetworkAddEdit from './SettingsLISHNetworkAddEdit.svelte';
	import LISHNetworkExport from './SettingsLISHNetworkExport.svelte';
	import LISHNetworkExportAll from './SettingsLISHNetworkExportAll.svelte';
	import LISHNetworkPublic from './SettingsLISHNetworkPublic.svelte';
	import NodeInfoRow from '../../components/NodeInfo/NodeInfoRow.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();
	let removeBackHandler: (() => void) | null = null;
	let showAddEdit = $state(false);
	let showExport = $state(false);
	let showExportAll = $state(false);
	let showPublic = $state(false);
	let showDeleteConfirm = $state(false);
	let editingNetwork = $state<LISHNetworkConfig | null>(null);
	let exportingNetwork = $state<LISHNetworkConfig | null>(null);
	let deletingNetwork = $state<LISHNetworkConfig | null>(null);

	// Networks loaded from backend
	let networks = $state<LISHNetworkConfig[]>([]);
	let globalNodeInfo = $state<NetworkNodeInfo | null>(null);
	let nodeInfoShowAddresses = $state(false);
	let networkErrors = $state<Record<string, string>>({});

	async function loadNetworks(): Promise<void> {
		const [nets, nodeInfo] = await Promise.all([getNetworks(), api.lishnets.getNodeInfo().catch((): null => null)]);
		globalNodeInfo = nodeInfo;
		networks = nets;
	}

	// Row offsets for positions
	let nodeInfoOffset = $derived(globalNodeInfo ? 1 + (nodeInfoShowAddresses ? globalNodeInfo.addresses.length : 0) : 0);

	function openPublic(): void {
		showPublic = true;
		navHandle.pause();
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
		await tick();
		navHandle.resume();
		activateArea(areaID);
	}

	function openAddNetwork(): void {
		editingNetwork = null;
		showAddEdit = true;
		navHandle.pause();
		pushBreadcrumb($t('common.add'));
		removeBackHandler = pushBackHandler(handleAddEditBack);
	}

	function openImport(): void {
		navigateTo('import-lishnet');
	}

	function openExportAll(): void {
		showExportAll = true;
		navHandle.pause();
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
		await tick();
		navHandle.resume();
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
			networkErrors = { ...networkErrors, [network.networkID]: translateError(e) };
		}
	}

	async function moveNetwork(index: number, up: boolean): Promise<void> {
		const newIndex = up ? index - 1 : index + 1;
		if (newIndex < 0 || newIndex >= networks.length) return;
		const temp = networks[index]!;
		networks[index] = networks[newIndex]!;
		networks[newIndex] = temp;
		networks = [...networks]; // Trigger reactivity
		// Move selection to follow the moved network
		const newY = newIndex + 1 + nodeInfoOffset;
		navHandle.controller.select([0, newY]);
		// Save new order to backend
		await api.lishnets.replace(networks);
	}

	function openExport(network: LISHNetworkConfig): void {
		exportingNetwork = network;
		showExport = true;
		navHandle.pause();
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
		await tick();
		navHandle.resume();
		activateArea(areaID);
	}

	function openEditNetwork(network: LISHNetworkConfig): void {
		editingNetwork = network;
		showAddEdit = true;
		navHandle.pause();
		pushBreadcrumb(`${network.name} - ${$t('common.edit')}`);
		removeBackHandler = pushBackHandler(handleAddEditBack);
	}

	function deleteNetwork(network: LISHNetworkConfig): void {
		deletingNetwork = network;
		showDeleteConfirm = true;
		navHandle.pause();
		pushBreadcrumb(`${network.name} - ${$t('common.delete')}`);
	}

	async function confirmDeleteNetwork(): Promise<void> {
		if (deletingNetwork) {
			await deleteNetworkFromAPI(deletingNetwork.networkID);
			const deletedName = deletingNetwork.name;
			networks = networks.filter(n => n.networkID !== deletingNetwork!.networkID);
			addNotification(tt('settings.lishNetwork.networkDeleted', { name: deletedName }), 'warning');
			deletingNetwork = null;
			showDeleteConfirm = false;
			popBreadcrumb();
			await tick();
			navHandle.resume();
			activateArea(areaID);
		}
	}

	async function cancelDelete(): Promise<void> {
		deletingNetwork = null;
		showDeleteConfirm = false;
		popBreadcrumb();
		await tick();
		navHandle.resume();
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
		await tick();
		navHandle.resume();
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
		await tick();
		navHandle.resume();
		activateArea(areaID);
	}

	const navHandle = createNavArea(() => ({ areaID, position, onBack, activate: true }));

	onMount(() => {
		loadNetworks();
		subscribePeerCounts();
		return () => {
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

	.network {
		display: flex;
		flex-direction: column;
		gap: 2vh;
		width: 100%;
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

	.network .network-id {
		font-size: 2vh;
		font-family: var(--font-mono);
		color: var(--secondary-foreground);
		word-break: break-all;
		padding: 1vh;
		background-color: var(--secondary-soft-background);
		border: 0.2vh solid var(--secondary-softer-background);
		border-radius: 1vh;
		text-align: center;
	}

	.network .description {
		padding: 2vh;
		font-size: 2vh;
		background-color: var(--secondary-soft-background);
		color: var(--secondary-foreground);
		border: 0.2vh solid var(--secondary-softer-background);
		border-radius: 1vh;
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
{:else if showDeleteConfirm && deletingNetwork}
	<ConfirmDialog title={$t('common.delete')} message={$t('settings.lishNetwork.confirmDelete', { name: deletingNetwork.name })} confirmLabel={$t('common.yes')} cancelLabel={$t('common.no')} confirmIcon="/img/check.svg" cancelIcon="/img/cross.svg" {position} onConfirm={confirmDeleteNetwork} onBack={cancelDelete} />
{:else}
	<div class="lish-network-list">
		<div class="container">
			<ButtonBar basePosition={[0, 0]}>
				<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} padding="1vh 1.5vh" fontSize="1.6vh" />
				<Button icon="/img/online.svg" label={$t('settings.lishNetwork.publicList')} onConfirm={openPublic} padding="1vh 1.5vh" fontSize="1.6vh" />
				<Button icon="/img/plus.svg" label={$t('common.add')} onConfirm={openAddNetwork} padding="1vh 1.5vh" fontSize="1.6vh" />
				<Button icon="/img/import.svg" label={$t('common.import')} onConfirm={openImport} padding="1vh 1.5vh" fontSize="1.6vh" />
				<Button icon="/img/export.svg" label={$t('common.exportAll')} onConfirm={openExportAll} padding="1vh 1.5vh" fontSize="1.6vh" />
			</ButtonBar>
			{#if globalNodeInfo}
				<NodeInfoRow nodeInfo={globalNodeInfo} rowY={1} bind:showAddresses={nodeInfoShowAddresses} />
			{/if}
			{#if networks.length === 0}
				<Alert type="warning" message={$t('settings.lishNetwork.emptyList')} />
			{:else}
				{#each networks as network, i}
					{@const rowY = i + 1 + nodeInfoOffset}
					<Row selected={navHandle.controller.isYSelected(rowY)}>
						<div class="network">
							<div class="header">
								<div class="name">{network.name}</div>
								{#if network.enabled && $peerCounts[network.networkID] !== undefined}
									<div class="peer-count">{$t('settings.lishNetwork.connectedPeers', { count: String($peerCounts[network.networkID]!) })}</div>
								{/if}
							</div>
							<div class="network-id">{network.networkID}</div>
							{#if network.description}
								<div class="description">
									{#each network.description.split('\n') as line, li}{#if li > 0}<br />{/if}{line}{/each}
								</div>
							{/if}
							{#if networkErrors[network.networkID]}
								<Alert type="error" message={networkErrors[network.networkID]!} />
							{/if}
							<div class="buttons">
								<Button icon="/img/connect.svg" label={network.enabled ? $t('common.disconnect') : $t('common.connect')} active={network.enabled} position={[0, rowY]} onConfirm={() => connectNetwork(network)} />
								<Button icon="/img/export.svg" label={$t('common.export')} position={[1, rowY]} onConfirm={() => openExport(network)} />
								<Button icon="/img/edit.svg" label={$t('common.edit')} position={[2, rowY]} onConfirm={() => openEditNetwork(network)} />
								<Button icon="/img/del.svg" label={$t('common.delete')} position={[3, rowY]} onConfirm={() => deleteNetwork(network)} />
								{#if i > 0}
									<Button icon="/img/up.svg" position={[4, rowY]} onConfirm={() => moveNetwork(i, true)} padding="1vh" fontSize="4vh" width="auto" />
								{/if}
								{#if i < networks.length - 1}
									<Button icon="/img/down.svg" position={[5, rowY]} onConfirm={() => moveNetwork(i, false)} padding="1vh" fontSize="4vh" width="auto" />
								{/if}
							</div>
						</div>
					</Row>
				{/each}
			{/if}
		</div>
	</div>
{/if}
