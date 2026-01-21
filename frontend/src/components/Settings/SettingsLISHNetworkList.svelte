<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, setAreaPosition, removeArea, activateArea } from '../../scripts/areas.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import Button from '../Buttons/Button.svelte';
	import Row from '../Row/Row.svelte';
	import LISHNetworkAddEdit from './SettingsLISHNetworkAddEdit.svelte';
	import LISHNetworkImport from './SettingsLISHNetworkImport.svelte';
	interface Props {
		areaID: string;
		onBack?: () => void;
	}
	interface Network {
		id: string;
		name: string;
	}
	let { areaID, onBack }: Props = $props();
	const editAreaID = areaID + '-edit';
	const importAreaID = areaID + '-import';
	let removeBackHandler: (() => void) | null = null;
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0);
	let buttonIndex = $state(0); // 0 = Add, 1 = Import (for top row); 0 = Connect, 1 = Edit, 2 = Delete (for network rows)
	let showAddEdit = $state(false);
	let showImport = $state(false);
	let editingNetwork = $state<Network | null>(null);
	let rowElements: HTMLElement[] = $state([]);

	// Mock data - replace with actual data source
	let networks = $state<Network[]>([
		{ id: '1', name: 'Main Network' },
		{ id: '2', name: 'Backup Network' },
	]);

	// Items: Top buttons row (0), network rows (1 to networks.length), Back button (last)
	let totalItems = $derived(networks.length + 2);

	// Check if current row is the top row (has Add/Import buttons)
	let isTopRow = $derived(selectedIndex === 0);

	// Check if current row is a network row (has Edit/Delete buttons)
	let isNetworkRow = $derived(selectedIndex > 0 && selectedIndex < totalItems - 1);

	function openAddNetwork() {
		editingNetwork = null;
		showAddEdit = true;
		setAreaPosition(areaID, { x: -999, y: -999 }); // Move original area out of the way
		setAreaPosition(editAreaID, { x: 0, y: 2 });
		pushBreadcrumb($t.common?.add ?? 'Add');
		removeBackHandler = pushBackHandler(handleAddEditBack);
	}

	function openImport() {
		showImport = true;
		setAreaPosition(areaID, { x: -999, y: -999 }); // Move original area out of the way
		setAreaPosition(importAreaID, { x: 0, y: 2 });
		pushBreadcrumb($t.common?.import ?? 'Import');
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

	function connectNetwork(network: Network) {
		// TODO: Implement actual connection logic
		console.log('Connecting to network:', network.name);
	}

	function openEditNetwork(network: Network) {
		editingNetwork = network;
		showAddEdit = true;
		setAreaPosition(areaID, { x: -999, y: -999 }); // Move original area out of the way
		setAreaPosition(editAreaID, { x: 0, y: 2 });
		pushBreadcrumb($t.common?.edit ?? 'Edit');
		removeBackHandler = pushBackHandler(handleAddEditBack);
	}

	function deleteNetwork(network: Network) {
		networks = networks.filter(n => n.id !== network.id);
		// Adjust selected index if needed
		if (selectedIndex >= totalItems) selectedIndex = totalItems - 1;
		buttonIndex = 0;
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

	function handleSave(network: Network) {
		if (editingNetwork) {
			// Update existing
			const index = networks.findIndex(n => n.id === editingNetwork!.id);
			if (index !== -1) networks[index] = network;
		} else {
			// Add new
			networks = [...networks, { ...network, id: crypto.randomUUID() }];
		}
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
				const maxIndex = isTopRow ? 1 : isNetworkRow ? 2 : 0;
				if (buttonIndex < maxIndex) {
					buttonIndex++;
					return true;
				}
				return false;
			},
			confirmDown: () => {},
			confirmUp: () => {
				if (selectedIndex === 0) {
					if (buttonIndex === 0) openAddNetwork();
					else openImport();
				} else if (selectedIndex === totalItems - 1) onBack?.();
				else {
					const networkIndex = selectedIndex - 1;
					const network = networks[networkIndex];
					if (network) {
						if (buttonIndex === 0) connectNetwork(network);
						else if (buttonIndex === 1) openEditNetwork(network);
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

	.network-name {
		font-size: 2.5vh;
		font-weight: bold;
		color: var(--secondary-foreground);
	}

	.buttons {
		display: flex;
		gap: 1vh;
	}
</style>

{#if showAddEdit}
	<LISHNetworkAddEdit areaID={editAreaID} network={editingNetwork} onBack={handleAddEditBack} onSave={handleSave} />
{:else if showImport}
	<LISHNetworkImport areaID={importAreaID} onBack={handleImportBack} />
{:else}
	<div class="lish-network-list">
		<div class="container">
			<div class="top-buttons" bind:this={rowElements[0]}>
				<Button label={$t.common?.add ?? 'Add'} selected={active && selectedIndex === 0 && buttonIndex === 0} onConfirm={openAddNetwork} />
				<Button label={$t.common?.import ?? 'Import'} selected={active && selectedIndex === 0 && buttonIndex === 1} onConfirm={openImport} />
			</div>
			{#each networks as network, i}
				<div bind:this={rowElements[i + 1]}>
					<Row selected={active && selectedIndex === i + 1}>
						<div class="network-name">{network.name}</div>
						<div class="buttons">
							<Button label={$t.common?.connect ?? 'Connect'} selected={active && selectedIndex === i + 1 && buttonIndex === 0} onConfirm={() => connectNetwork(network)} />
							<Button label={$t.common?.edit ?? 'Edit'} selected={active && selectedIndex === i + 1 && buttonIndex === 1} onConfirm={() => openEditNetwork(network)} />
							<Button label={$t.common?.delete ?? 'Delete'} selected={active && selectedIndex === i + 1 && buttonIndex === 2} onConfirm={() => deleteNetwork(network)} />
						</div>
					</Row>
				</div>
			{/each}
		</div>
		<div class="back" bind:this={rowElements[totalItems - 1]}>
			<Button label={$t.common?.back} selected={active && selectedIndex === totalItems - 1} onConfirm={onBack} />
		</div>
	</div>
{/if}
