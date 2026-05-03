<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { createSubPage } from '../../scripts/subPage.svelte.ts';
	import { createLishSearch } from '../../scripts/lishSearch.svelte.ts';
	import { type PeerListEntry, type LISHNetworkConfig, type NetworkNodeInfo, type LishSearchResult } from '@shared';
	import { api } from '../../scripts/api.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Tabs, { type TabDef } from '../../components/Tabs/Tabs.svelte';
	import PeerDetail from './NetworkPeersPeerDetail.svelte';
	import NetworkLishs from './NetworkLishs.svelte';
	import NetworkLishsPeerList from './NetworkLishsPeerList.svelte';
	import NetworkPeers from './NetworkPeers.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, onBack }: Props = $props();

	// =================== Tabs ===================
	let activeTab = $state<string>('lishs');
	let tabDefs = $derived<TabDef[]>([
		{ id: 'lishs', icon: '/img/share.svg', label: $t('network.tabLishs') },
		{ id: 'peers', icon: '/img/person.svg', label: $t('network.tabPeers') },
	]);

	// =================== Peers data (shared between Peers tab and the LISH-peers popup) ===================
	let peers = $state<PeerListEntry[]>([]);
	let networks = $state<LISHNetworkConfig[]>([]);
	let nodeInfo = $state<NetworkNodeInfo | null>(null);
	let peersLoading = $state(true);
	let peersError = $state('');
	let peersSearch = $state('');
	let selectedNetworkID = $state('');
	let nodeInfoShowAddresses = $state(false);

	const nodeInfoRowY = 2;
	let nodeInfoAddressRows = $derived(nodeInfo && nodeInfoShowAddresses ? nodeInfo.addresses.length : 0);
	let peersBaseY = $derived((nodeInfo ? nodeInfoRowY + 1 : 2) + nodeInfoAddressRows);

	let filteredPeers = $derived.by((): PeerListEntry[] => {
		let result = peers;
		if (selectedNetworkID) result = result.filter(p => p.networks.some(n => n.networkID === selectedNetworkID));
		if (peersSearch) {
			const q = peersSearch.toLowerCase();
			result = result.filter(p => p.peerID.toLowerCase().includes(q));
		}
		return result;
	});

	async function loadPeerData(): Promise<void> {
		peersLoading = true;
		peersError = '';
		try {
			const [peerList, netList, info] = await Promise.all([api.lishnets.getPeers(), api.lishnets.list(), api.lishnets.getNodeInfo().catch((): null => null)]);
			peers = peerList;
			networks = netList.filter(n => n.enabled);
			nodeInfo = info;
		} catch (e: any) {
			peersError = translateError(e);
			peers = [];
		}
		peersLoading = false;
	}

	function refreshActive(): void {
		// LISH search refreshes via re-running the query; we only refresh the peer list here.
		if (activeTab === 'peers') void loadPeerData();
	}

	// =================== LISH search session (owned here so listRange can read result count) ===================
	const search = createLishSearch();

	// =================== LISH peer-list page (overlay over the search tab) ===================
	// Hold the LISH id only and look the row up in `search.results` via $derived. This keeps the
	// detail page reactive to backend updates without depending on object-identity preservation
	// in the search reducer — the parent always reads the freshest row by id, so the search
	// reducer is free to replace row objects (simpler, no cognitive load about mutate-vs-replace).
	let lishPeerListRowID = $state<string | null>(null);
	let lishPeerListRow = $derived<LishSearchResult | null>(lishPeerListRowID === null ? null : search.results.find(r => r.id === lishPeerListRowID) ?? null);

	function openLishPeerList(row: LishSearchResult): void {
		lishPeerListRowID = row.id;
		lishPeerListSubPage.enter(row.name ?? row.id.slice(0, 16) + '...');
	}
	async function handleLishPeerListBack(): Promise<void> {
		lishPeerListRowID = null;
		await lishPeerListSubPage.exit();
	}
	async function openPeerFromLishPeerList(peerID: string, networkID: string, lishID: string): Promise<void> {
		// Close the LISH peer-list page first, then open the PeerDetail page on top of the search tab.
		await handleLishPeerListBack();
		openPeerFromSearch(peerID, networkID, lishID);
	}

	// =================== PeerDetail overlay ===================
	let selectedPeer = $state<PeerListEntry | null>(null);
	let selectedPeerNetworkID = $state('');
	let highlightLishID = $state<string | undefined>(undefined);

	function openPeerDetail(peer: PeerListEntry, networkID: string, lishID?: string): void {
		selectedPeer = peer;
		selectedPeerNetworkID = networkID;
		highlightLishID = lishID;
		detailSubPage.enter(peer.peerID.slice(0, 16) + '...');
	}
	function openPeerFromPeersTab(peer: PeerListEntry): void {
		const netID = peer.networks[0]?.networkID ?? '';
		openPeerDetail(peer, netID);
	}
	function openPeerFromSearch(peerID: string, networkID: string, lishID: string): void {
		// Build a minimal PeerListEntry — we don't have direct/relay counts for a peer discovered via
		// search. PeerDetail only uses peerID + networks for display; the LISH list is fetched fresh.
		const networkConfig = networks.find(n => n.networkID === networkID);
		const networkName = networkConfig?.name ?? networkID;
		const peer: PeerListEntry = {
			peerID,
			networks: networkID ? [{ networkID, networkName }] : [],
			direct: 0,
			relay: 0,
		};
		openPeerDetail(peer, networkID, lishID);
	}
	async function handleDetailBack(): Promise<void> {
		selectedPeer = null;
		highlightLishID = undefined;
		await detailSubPage.exit();
	}

	// =================== NavArea grid ===================
	// y=0 — top bar (Back, Refresh)
	// y=1 — tab header
	// LISHs tab:
	//   y=2 — search input + buttons
	//   y=3+i — LISH rows
	// Peers tab:
	//   y=2 — NodeInfoRow toggle (when present)
	//   y=3 .. 2+N — NodeInfoRow address rows (when expanded; N = address count)
	//   y=peersBaseY — filters
	//   y=peersBaseY+1+i — peer rows
	const navHandle = createNavArea(() => ({
		areaID,
		position,
		onBack,
		activate: true,
		listRange: () => {
			if (activeTab === 'peers') {
				return [peersBaseY, Math.max(peersBaseY, peersBaseY + filteredPeers.length)];
			}
			return [2, Math.max(2, 2 + search.results.length)];
		},
	}));
	const lishPeerListSubPage = createSubPage(navHandle, () => areaID);
	const detailSubPage = createSubPage(navHandle, () => areaID);

	onMount(() => {
		void loadPeerData();
	});

	onDestroy(() => {
		search.dispose();
	});
</script>

<style>
	.network-page {
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
</style>

{#if detailSubPage.active && selectedPeer}
	<PeerDetail {areaID} {position} peer={selectedPeer} networkID={selectedPeerNetworkID} {highlightLishID} onBack={() => void handleDetailBack()} />
{:else if lishPeerListSubPage.active && lishPeerListRow}
	<NetworkLishsPeerList {areaID} {position} row={lishPeerListRow} {networks} onBack={() => void handleLishPeerListBack()} onOpenPeer={openPeerFromLishPeerList} />
{:else}
	<div class="network-page">
		<div class="container">
			<ButtonBar basePosition={[0, 0]}>
				<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} width="auto" />
				<Button icon="/img/restart.svg" label={$t('common.refresh')} onConfirm={refreshActive} width="auto" />
			</ButtonBar>
			<Tabs tabs={tabDefs} bind:activeID={activeTab} position={[0, 1]} />
			{#if activeTab === 'lishs'}
				<NetworkLishs baseY={2} {search} onOpenLishPeers={openLishPeerList} />
			{:else}
				<NetworkPeers {peers} {filteredPeers} {networks} {nodeInfo} loading={peersLoading} error={peersError} baseY={peersBaseY} {nodeInfoRowY} bind:peersSearch bind:selectedNetworkID bind:nodeInfoShowAddresses onOpenPeer={openPeerFromPeersTab} />
			{/if}
		</div>
	</div>
{/if}
