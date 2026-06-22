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
	let lishPeerListRow = $state<LishSearchResult | null>(null);

	function openLishPeerList(row: LishSearchResult): void {
		lishPeerListRow = row;
		lishPeerListSubPage.enter(row.name ?? row.id.slice(0, 16) + '...');
	}
	async function handleLishPeerListBack(): Promise<void> {
		lishPeerListRow = null;
		await lishPeerListSubPage.exit();
	}
	function openPeerFromLishPeerList(peerID: string, networkID: string, lishID: string): void {
		// Layer PeerDetail on top of the LISH peer-list (instead of closing the
		// peer-list first). Back from PeerDetail returns to the peer-list — one
		// level up — and a second back returns to the Network root. Closing the
		// peer-list first would skip a level and confuse the user.
		openPeerFromSearch(peerID, networkID, lishID);
	}

	// =================== PeerDetail overlay ===================
	let selectedPeer = $state<PeerListEntry | null>(null);
	let selectedPeerNetworkID = $state('');
	let highlightLishID = $state<string | undefined>(undefined);
	/**
	 * Bumped after each PeerDetail exit so the embedded LishPeerList re-mounts
	 * via `{#key}`. LishPeerList registers its own `createNavArea` with the
	 * shared `areaID`; without a forced re-mount, `detailSubPage.exit()` would
	 * already have called `navHandle.resume()` (which re-registers the parent
	 * Network handler under the same `areaID`, overwriting LishPeerList's
	 * registration via last-write-wins in `useArea`). Re-mounting LishPeerList
	 * makes it the final writer so keyboard navigation reaches its handlers.
	 */
	let lishPeerListMountKey = $state(0);

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
		// `detailSubPage.exit()` calls `navHandle.resume()` which re-registers
		// the parent Network handler under the shared `areaID`, overwriting any
		// existing LishPeerList registration. Force LishPeerList to re-mount so
		// its `createNavArea` runs again as the last writer — that restores its
		// keyboard navigation when control returns to the peer-list view.
		if (lishPeerListSubPage.active) lishPeerListMountKey++;
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
		listRange: (): [number, number] => {
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
	{#key lishPeerListMountKey}
		<NetworkLishsPeerList {areaID} {position} row={lishPeerListRow} {networks} onBack={() => void handleLishPeerListBack()} onOpenPeer={openPeerFromLishPeerList} />
	{/key}
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
