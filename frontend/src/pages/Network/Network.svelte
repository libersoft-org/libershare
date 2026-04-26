<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { activateArea } from '../../scripts/areas.ts';
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
	let showLishPeerList = $state(false);
	let lishPeerListRow = $state<LishSearchResult | null>(null);
	let removeLishPeerListBackHandler: (() => void) | null = null;

	function openLishPeerList(row: LishSearchResult): void {
		lishPeerListRow = row;
		showLishPeerList = true;
		navHandle.pause();
		pushBreadcrumb(row.name ?? row.id.slice(0, 16) + '...');
		removeLishPeerListBackHandler = pushBackHandler(handleLishPeerListBack);
	}
	async function handleLishPeerListBack(): Promise<void> {
		if (removeLishPeerListBackHandler) {
			removeLishPeerListBackHandler();
			removeLishPeerListBackHandler = null;
		}
		popBreadcrumb();
		showLishPeerList = false;
		lishPeerListRow = null;
		await tick();
		navHandle.resume();
		activateArea(areaID);
	}
	async function openPeerFromLishPeerList(peerID: string, networkID: string, lishID: string): Promise<void> {
		// Close the LISH peer-list page first, then open the PeerDetail page on top of the search tab.
		await handleLishPeerListBack();
		openPeerFromSearch(peerID, networkID, lishID);
	}

	// =================== PeerDetail overlay ===================
	let showDetail = $state(false);
	let selectedPeer = $state<PeerListEntry | null>(null);
	let selectedPeerNetworkID = $state('');
	let highlightLishID = $state<string | undefined>(undefined);
	let removeBackHandler: (() => void) | null = null;

	function openPeerDetail(peer: PeerListEntry, networkID: string, lishID?: string): void {
		selectedPeer = peer;
		selectedPeerNetworkID = networkID;
		highlightLishID = lishID;
		showDetail = true;
		navHandle.pause();
		pushBreadcrumb(peer.peerID.slice(0, 16) + '...');
		removeBackHandler = pushBackHandler(handleDetailBack);
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
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		showDetail = false;
		selectedPeer = null;
		highlightLishID = undefined;
		await tick();
		navHandle.resume();
		activateArea(areaID);
	}

	// =================== NavArea grid ===================
	// y=0 — top bar (Back, Refresh)
	// y=1 — tab header
	// LISHs tab:
	//   y=2 — search input + buttons
	//   y=3+i — LISH rows
	// Peers tab:
	//   y=2 — NodeInfoRow (when present)
	//   y=baseY (3 or 2) — filters
	//   y=baseY+1+i — peer rows
	const navHandle = createNavArea(() => ({
		areaID,
		position,
		onBack,
		activate: true,
		listRange: () => {
			if (activeTab === 'peers') {
				const baseY = nodeInfo ? 3 : 2;
				return [baseY, Math.max(baseY, baseY + filteredPeers.length)];
			}
			return [2, Math.max(2, 2 + search.results.length)];
		},
	}));

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

{#if showDetail && selectedPeer}
	<PeerDetail {areaID} {position} peer={selectedPeer} networkID={selectedPeerNetworkID} {highlightLishID} onBack={handleDetailBack} />
{:else if showLishPeerList && lishPeerListRow}
	<NetworkLishsPeerList {areaID} {position} row={lishPeerListRow} {networks} onBack={handleLishPeerListBack} onOpenPeer={openPeerFromLishPeerList} />
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
				{@const baseY = nodeInfo ? 3 : 2}
				<NetworkPeers {peers} {filteredPeers} {networks} {nodeInfo} loading={peersLoading} error={peersError} {baseY} bind:peersSearch bind:selectedNetworkID onOpenPeer={openPeerFromPeersTab} />
			{/if}
		</div>
	</div>
{/if}
