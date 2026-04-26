<script lang="ts">
	import { onMount } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { activateArea } from '../../scripts/areas.ts';
	import { type PeerListEntry, type LISHNetworkConfig, type NetworkNodeInfo } from '@shared';
	import { api } from '../../scripts/api.ts';
	import { tick } from 'svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import Table from '../../components/Table/Table.svelte';
	import TableHeader from '../../components/Table/TableHeader.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	import Input from '../../components/Input/Input.svelte';
	import Select from '../../components/Input/Select.svelte';
	import SelectOption from '../../components/Input/SelectOption.svelte';
	import NodeInfoRow from '../../components/NodeInfo/NodeInfoRow.svelte';
	import PeerDetail from './PeerDetail.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();
	let peers = $state<PeerListEntry[]>([]);
	let networks = $state<LISHNetworkConfig[]>([]);
	let nodeInfo = $state<NetworkNodeInfo | null>(null);
	let loading = $state(true);
	let error = $state('');
	let search = $state('');
	let selectedNetworkID = $state<string>('');
	let removeBackHandler: (() => void) | null = null;
	// Detail view state
	let showDetail = $state(false);
	let selectedPeer = $state<PeerListEntry | null>(null);
	let selectedPeerNetworkID = $state('');
	let filteredPeers = $derived.by((): PeerListEntry[] => {
		let result = peers;
		if (selectedNetworkID) result = result.filter(p => p.networks.some(n => n.networkID === selectedNetworkID));
		if (search) {
			const q = search.toLowerCase();
			result = result.filter(p => p.peerID.toLowerCase().includes(q));
		}
		return result;
	});

	async function loadData(): Promise<void> {
		loading = true;
		error = '';
		try {
			const [peerList, netList, info] = await Promise.all([api.lishnets.getPeers(), api.lishnets.list(), api.lishnets.getNodeInfo().catch((): null => null)]);
			peers = peerList;
			networks = netList.filter(n => n.enabled);
			nodeInfo = info;
		} catch (e: any) {
			error = translateError(e);
			peers = [];
		}
		loading = false;
	}

	function getNetworkNames(peer: PeerListEntry): string {
		return peer.networks.map(n => n.networkName).join(', ');
	}

	function openPeerDetail(peer: PeerListEntry): void {
		selectedPeer = peer;
		// Pick first network for communication
		selectedPeerNetworkID = peer.networks[0]?.networkID ?? '';
		showDetail = true;
		navHandle.pause();
		pushBreadcrumb(peer.peerID.slice(0, 16) + '...');
		removeBackHandler = pushBackHandler(handleDetailBack);
	}

	async function handleDetailBack(): Promise<void> {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		showDetail = false;
		selectedPeer = null;
		await tick();
		navHandle.resume();
		activateArea(areaID);
	}

	const navHandle = createNavArea(() => ({
		areaID,
		position,
		onBack,
		activate: true,
		listRange: () => {
			const nodeOffset = nodeInfo ? 1 : 0;
			const start = 2 + nodeOffset;
			return [start, Math.max(start, filteredPeers.length + 1 + nodeOffset)];
		},
	}));

	onMount(() => {
		loadData();
	});
</script>

<style>
	.peers-page {
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

	.filters {
		display: flex;
		gap: 2vh;
		align-items: center;
		flex-wrap: wrap;
	}

	.peer-id {
		font-family: var(--font-mono);
		font-size: 1.8vh;
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.networks-col {
		font-size: 1.8vh;
		white-space: nowrap;
	}

	.connections {
		display: flex;
		flex-direction: column;
		line-height: 1.4;
		white-space: nowrap;
	}
</style>

{#if showDetail && selectedPeer}
	<PeerDetail {areaID} {position} peer={selectedPeer} networkID={selectedPeerNetworkID} onBack={handleDetailBack} />
{:else}
	<div class="peers-page">
		<div class="container">
			<ButtonBar basePosition={[0, 0]}>
				<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} width="auto" />
				<Button icon="/img/restart.svg" label={$t('common.refresh')} onConfirm={loadData} width="auto" />
			</ButtonBar>
			{#if nodeInfo}
				<NodeInfoRow {nodeInfo} rowY={1} />
			{/if}
			{#if loading}
				<Spinner size="8vh" />
			{:else if error}
				<Alert type="error" message={error} />
			{:else if peers.length === 0}
				<Alert type="warning" message={$t('peers.noPeers')} />
			{:else}
				{@const nodeOffset = nodeInfo ? 1 : 0}
				<div class="filters">
					<Input bind:value={search} placeholder={$t('peers.searchPlaceholder')} fontSize="2vh" padding="1vh 1.5vh" position={[0, 1 + nodeOffset]} />
					<Select bind:value={selectedNetworkID} fontSize="2vh" padding="1vh 1.5vh" position={[1, 1 + nodeOffset]}>
						<SelectOption value="" label={$t('peers.allNetworks')} />
						{#each networks as net}
							<SelectOption value={net.networkID} label={net.name} />
						{/each}
					</Select>
				</div>
				<Table columns="auto 1fr 30vh 15vh" columnsMobile="1fr auto">
					<TableHeader>
						<TableCell desktopOnly>#</TableCell>
						<TableCell>{$t('peers.peerID')}</TableCell>
						<TableCell align="center">{$t('peers.network')}</TableCell>
						<TableCell align="center">{$t('peers.connections')}</TableCell>
					</TableHeader>
					{#each filteredPeers as peer, i}
						<TableRow position={[0, i + 2 + nodeOffset]} onConfirm={() => openPeerDetail(peer)}>
							<TableCell desktopOnly>{i + 1}</TableCell>
							<TableCell><span class="peer-id">{peer.peerID}</span></TableCell>
							<TableCell align="center"><span class="networks-col">{getNetworkNames(peer)}</span></TableCell>
							<TableCell align="center">
								<div class="connections">
									{#if peer.direct > 0}<div>{$t('peers.direct', { count: String(peer.direct) })}</div>{/if}
									{#if peer.relay > 0}<div>{$t('peers.relayed', { count: String(peer.relay) })}</div>{/if}
								</div>
							</TableCell>
						</TableRow>
					{/each}
				</Table>
			{/if}
		</div>
	</div>
{/if}
