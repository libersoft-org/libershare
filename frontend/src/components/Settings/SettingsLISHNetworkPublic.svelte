<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { type LISHNetwork, DEFAULT_PUBLIC_LIST_URL, fetchPublicNetworks, getExistingNetworkIds, addNetworkIfNotExists } from '../../scripts/lishnet.ts';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';
	import Row from '../Row/Row.svelte';
	import Alert from '../Alert/Alert.svelte';
	import Spinner from '../Spinner/Spinner.svelte';
	interface Props {
		areaID: string;
		position?: Position;
		onBack?: () => void;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0); // 0 = URL row (input + Load), 1+ = network rows, last = Back
	let selectedColumn = $state(0); // 0 = URL input, 1 = Load button
	let urlInput: Input;
	let url = $state(DEFAULT_PUBLIC_LIST_URL);
	let publicNetworks = $state<LISHNetwork[]>([]);
	let loading = $state(false);
	let error = $state('');
	let addedNetworkIds = $state<Set<string>>(new Set());
	// Items: URL row (0), network rows (1 to publicNetworks.length), Back button (last)
	let totalItems = $derived(1 + publicNetworks.length + 1);

	function getErrorMessage(errorCode: string): string {
		switch (errorCode) {
			case 'INVALID_FORMAT':
				return $t.settings?.lishNetwork?.errorInvalidFormat || 'Invalid format - expected array';
			case 'NO_VALID_NETWORKS':
				return $t.settings?.lishNetwork?.errorNoValidNetworks || 'No valid networks found';
			default:
				return errorCode;
		}
	}

	async function loadPublicList() {
		if (!url.trim()) {
			error = $t.settings?.lishNetwork?.errorUrlRequired || 'URL is required';
			return;
		}
		loading = true;
		selectedColumn = 0; // Move selection to URL input while loading
		error = '';
		publicNetworks = [];

		const result = await fetchPublicNetworks(url);
		if (result.error) error = getErrorMessage(result.error);
		else {
			publicNetworks = result.networks;
			addedNetworkIds = getExistingNetworkIds();
		}
		loading = false;
	}

	function handleAddNetwork(network: LISHNetwork) {
		if (addNetworkIfNotExists(network)) addedNetworkIds = new Set([...addedNetworkIds, network.networkID]);
	}

	function isNetworkAdded(networkID: string): boolean {
		return addedNetworkIds.has(networkID);
	}

	onMount(() => {
		const unregister = useArea(
			areaID,
			{
				up: () => {
					if (selectedIndex > 0) {
						selectedIndex--;
						return true;
					}
					return false;
				},
				down: () => {
					if (selectedIndex < totalItems - 1) {
						selectedIndex++;
						return true;
					}
					return false;
				},
				left: () => {
					if (selectedIndex === 0 && selectedColumn > 0) {
						selectedColumn--;
						return true;
					}
					return false;
				},
				right: () => {
					if (selectedIndex === 0 && selectedColumn < 1 && !loading) {
						selectedColumn++;
						return true;
					}
					return false;
				},
				confirmDown: () => {
					if (selectedIndex === 0 && selectedColumn === 0) urlInput?.focus();
				},
				confirmUp: () => {
					if (selectedIndex === 0 && selectedColumn === 1) loadPublicList();
					else if (selectedIndex >= 1 && selectedIndex < totalItems - 1) {
						const networkIndex = selectedIndex - 1;
						const network = publicNetworks[networkIndex];
						if (network && !isNetworkAdded(network.networkID)) handleAddNetwork(network);
					} else if (selectedIndex === totalItems - 1) onBack?.();
				},
				confirmCancel: () => {},
				back: () => onBack?.(),
			},
			position
		);
		activateArea(areaID);
		return unregister;
	});
</script>

<style>
	.public-list {
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
		gap: 2vh;
		width: 1200px;
		max-width: 100%;
	}

	.url-row {
		display: flex;
		gap: 1vh;
		align-items: flex-end;
	}

	.url-input {
		flex: 1;
	}

	.networks {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		margin-top: 1vh;
	}

	.network {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 2vh;
		width: 100%;
	}

	.network-info {
		display: flex;
		flex-direction: column;
		gap: 0.5vh;
		flex: 1;
	}

	.network-name {
		font-size: 2.5vh;
		font-weight: bold;
		color: var(--secondary-foreground);
	}

	.network-description {
		font-size: 2vh;
		color: var(--disabled-foreground);
	}

	.back {
		margin-top: 2vh;
	}
</style>

<div class="public-list">
	<div class="container">
		<div class="url-row">
			<div class="url-input">
				<Input bind:this={urlInput} bind:value={url} label="URL" selected={active && selectedIndex === 0 && selectedColumn === 0} />
			</div>
			{#if !loading}
				<Button label={$t.common?.load} selected={active && selectedIndex === 0 && selectedColumn === 1} onConfirm={loadPublicList} />
			{/if}
		</div>
		{#if loading}
			<Spinner size="8vh" />
		{/if}
		{#if error}
			<Alert type="error" message={error} />
		{/if}
		{#if publicNetworks.length > 0}
			<div class="networks">
				{#each publicNetworks as network, i}
					<Row selected={active && selectedIndex === i + 1}>
						<div class="network">
							<div class="network-info">
								<div class="network-name">{network.name}</div>
								{#if network.description}
									<div class="network-description">{network.description}</div>
								{/if}
							</div>
							{#if isNetworkAdded(network.networkID)}
								<Button label={$t.common?.added} selected={false} />
							{:else}
								<Button label={$t.common?.add} selected={active && selectedIndex === i + 1} onConfirm={() => handleAddNetwork(network)} />
							{/if}
						</div>
					</Row>
				{/each}
			</div>
		{/if}
	</div>
	<div class="back">
		<Button icon="/img/back.svg" label={$t.common?.back} selected={active && selectedIndex === totalItems - 1} onConfirm={onBack} />
	</div>
</div>
