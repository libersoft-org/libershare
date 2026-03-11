<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea, type NavPos } from '../../scripts/navArea.svelte.ts';
	import { type LISHNetworkDefinition } from '@shared';
	import { productNetworkList } from '@shared';
	import { fetchPublicNetworks, getExistingNetworkIDs, addNetworkIfNotExists } from '../../scripts/lishNetwork.ts';
	import Button from '../../components/Buttons/Button.svelte';
	import Input from '../../components/Input/Input.svelte';
	import Row from '../../components/Row/Row.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();
	let url = $state(productNetworkList);
	let publicNetworks = $state<LISHNetworkDefinition[]>([]);
	let loading = $state(false);
	let error = $state('');
	let addedNetworkIDs = $state<Set<string>>(new Set());
	let backPos = $derived<NavPos>([0, publicNetworks.length + 1]);

	async function loadPublicList(): Promise<void> {
		if (!url.trim()) {
			error = $t('common.errorURLRequired');
			return;
		}
		loading = true;
		error = '';
		publicNetworks = [];

		const result = await fetchPublicNetworks(url);
		if (result.error) error = result.error;
		else {
			publicNetworks = result.networks;
			addedNetworkIDs = await getExistingNetworkIDs();
		}
		loading = false;
	}

	async function handleAddNetwork(network: LISHNetworkDefinition): Promise<void> {
		if (await addNetworkIfNotExists(network)) addedNetworkIDs = new Set([...addedNetworkIDs, network.networkID]);
	}

	function isNetworkAdded(networkID: string): boolean {
		return addedNetworkIDs.has(networkID);
	}

	const navHandle = createNavArea(() => ({ areaID, position, onBack, activate: true }));
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
		gap: 2vh;
		flex: 1;
	}

	.network-name {
		font-size: 2.5vh;
		font-weight: bold;
		color: var(--primary-foreground);
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
				<Input bind:value={url} label="URL" position={[0, 0]} />
			</div>
			{#if !loading}
				<Button icon="/img/download.svg" label={$t('common.load')} position={[1, 0]} onConfirm={loadPublicList} />
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
					<Row selected={navHandle.controller.isSelected([0, i + 1])}>
						<div class="network">
							<div class="network-info">
								<div class="network-name">{network.name}</div>
								{#if network.description}
									<div class="network-description">{@html network.description.replaceAll('\n', '<br />')}</div>
								{/if}
							</div>
							{#if isNetworkAdded(network.networkID)}
								<Button icon="/img/check.svg" label={$t('common.added')} position={[0, i + 1]} />
							{:else}
								<Button icon="/img/plus.svg" label={$t('common.add')} position={[0, i + 1]} onConfirm={() => handleAddNetwork(network)} />
							{/if}
						</div>
					</Row>
				{/each}
			</div>
		{/if}
	</div>
	<div class="back">
		<Button icon="/img/back.svg" label={$t('common.back')} position={backPos} onConfirm={onBack} />
	</div>
</div>
