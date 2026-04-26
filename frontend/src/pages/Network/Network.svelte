<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { activateArea } from '../../scripts/areas.ts';
	import { type PeerListEntry, type LISHNetworkConfig, type NetworkNodeInfo, type LishSearchResult } from '@shared';
	import { api } from '../../scripts/api.ts';
	import { formatSize } from '../../scripts/utils.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Tabs, { type TabDef } from '../../components/Tabs/Tabs.svelte';
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
	let activeTab = $state<string>('lishs');
	let tabDefs = $derived<TabDef[]>([
		{ id: 'lishs', icon: '/img/share.svg', label: $t('network.tabLishs') },
		{ id: 'peers', icon: '/img/person.svg', label: $t('network.tabPeers') },
	]);
	function handleTabChange(_id: string): void {
		// Close popups when the user switches tabs.
		peersPopupRow = null;
	}
	// =================== Peers tab state ===================
	let peers = $state<PeerListEntry[]>([]);
	let networks = $state<LISHNetworkConfig[]>([]);
	let nodeInfo = $state<NetworkNodeInfo | null>(null);
	let peersLoading = $state(true);
	let peersError = $state('');
	let peersSearch = $state('');
	let selectedNetworkID = $state<string>('');

	// =================== LISH search tab state ===================
	let lishQuery = $state('');
	let searchID = $state<string | null>(null);
	let searching = $state(false);
	let searchError = $state('');
	let searchResults = $state<LishSearchResult[]>([]);
	// Modal popup with the list of peers offering the LISH the user clicked.
	let peersPopupRow = $state<LishSearchResult | null>(null);

	// =================== Detail (PeerDetail) overlay ===================
	let showDetail = $state(false);
	let selectedPeer = $state<PeerListEntry | null>(null);
	let selectedPeerNetworkID = $state('');
	let highlightLishID = $state<string | undefined>(undefined);
	let removeBackHandler: (() => void) | null = null;

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

	function getNetworkNames(peer: PeerListEntry): string {
		return peer.networks.map(n => n.networkName).join(', ');
	}

	// =================== Tab switching ===================
	function refreshActive(): void {
		// Peer list refresh button. The LISH search tab refreshes by re-running the search.
		if (activeTab === 'peers') void loadPeerData();
	}

	// =================== LISH search ===================
	async function startLishSearch(): Promise<void> {
		const query = lishQuery.trim();
		if (query.length === 0) return;
		// Cancel any previous in-flight search before starting a fresh one.
		if (searchID) {
			try {
				await api.search.cancelSearch(searchID);
			} catch {}
		}
		searching = true;
		searchError = '';
		searchResults = [];
		peersPopupRow = null;
		try {
			const res = await api.search.startSearch(query);
			searchID = res.searchID;
		} catch (e: any) {
			searchError = translateError(e);
			searching = false;
			searchID = null;
		}
	}

	async function cancelLishSearch(): Promise<void> {
		if (!searchID) return;
		try {
			await api.search.cancelSearch(searchID);
		} catch {}
		// `search:lishs:complete` event will also flip `searching` to false; do it here in case it's missed.
		searching = false;
	}

	function handleSearchUpdate(data: unknown): void {
		const d = data as { searchID: string; lishs: LishSearchResult[] };
		if (d.searchID !== searchID) return;
		// Backend sends the cumulative row for each updated LISH; replace by id.
		const byID = new Map(searchResults.map(r => [r.id, r] as const));
		for (const row of d.lishs) byID.set(row.id, row);
		searchResults = [...byID.values()];
	}
	function handleSearchComplete(data: unknown): void {
		const d = data as { searchID: string };
		if (d.searchID !== searchID) return;
		searching = false;
	}

	function openPeersPopup(row: LishSearchResult): void {
		peersPopupRow = row;
	}
	function closePeersPopup(): void {
		peersPopupRow = null;
	}
	function stopPropagation(e: Event): void {
		e.stopPropagation();
	}

	// =================== Open peer detail (from either tab) ===================
	function openPeerDetail(peer: PeerListEntry, networkID: string, lishID?: string): void {
		selectedPeer = peer;
		selectedPeerNetworkID = networkID;
		highlightLishID = lishID;
		showDetail = true;
		peersPopupRow = null;
		navHandle.pause();
		pushBreadcrumb(peer.peerID.slice(0, 16) + '...');
		removeBackHandler = pushBackHandler(handleDetailBack);
	}

	function openPeerDetailFromPeersTab(peer: PeerListEntry): void {
		const netID = peer.networks[0]?.networkID ?? '';
		openPeerDetail(peer, netID);
	}

	function openPeerFromSearchPopup(peerID: string, networkID: string, lishID: string): void {
		// Build a minimal PeerListEntry. We don't have direct/relay counts for a peer discovered via
		// search (it may not be in the joined-peers list). PeerDetail only uses peerID + networks
		// for display, and the LISH list is fetched fresh from the peer.
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

	// =================== NavArea ===================
	// Layout grid (y-coordinates):
	//   y=0 — top bar: Back, Refresh
	//   y=1 — tab header: [LISHe] [Účastníci]
	//   LISHs tab:
	//     y=2 — search input + buttons
	//     y=3+i — LISH rows
	//   Peers tab:
	//     y=2 — NodeInfoRow (when available)
	//     y=baseY — filters (baseY = 3 if nodeInfo else 2)
	//     y=baseY+1+i — peer rows
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
			return [2, Math.max(2, 2 + searchResults.length)];
		},
	}));

	let unsubUpdate: (() => void) | undefined | void;
	let unsubComplete: (() => void) | undefined | void;

	onMount(() => {
		void api.subscribe('search:lishs:update', 'search:lishs:complete');
		unsubUpdate = api.on('search:lishs:update', handleSearchUpdate);
		unsubComplete = api.on('search:lishs:complete', handleSearchComplete);
		// Eagerly load network/node metadata (used by both tabs and the LISH popup network names).
		void loadPeerData();
	});

	onDestroy(() => {
		unsubUpdate?.();
		unsubComplete?.();
		void api.unsubscribe('search:lishs:update', 'search:lishs:complete');
		// Cancel any in-flight search on page exit.
		if (searchID) void api.search.cancelSearch(searchID).catch(() => {});
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

	.filters {
		display: flex;
		gap: 2vh;
		align-items: center;
		flex-wrap: wrap;
	}

	.filters :global(.input-wrapper) {
		flex: 1;
		min-width: 24vh;
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

	.lish-id {
		font-family: var(--font-mono);
		font-size: 1.4vh;
		color: var(--disabled-foreground);
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.lish-name {
		font-size: 1.8vh;
		font-weight: bold;
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.search-status {
		font-size: 1.6vh;
		color: var(--secondary-foreground);
		display: flex;
		align-items: center;
		gap: 1vh;
	}

	.popup-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}

	.popup {
		background: var(--secondary-background);
		border-radius: 2vh;
		padding: 3vh;
		max-width: 900px;
		width: 90vw;
		max-height: 80vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 2vh;
	}

	.popup-title {
		font-size: 2.4vh;
		font-weight: bold;
	}

	.popup-subtitle {
		font-size: 1.6vh;
		color: var(--disabled-foreground);
		font-family: var(--font-mono);
		word-break: break-all;
	}
</style>

{#if showDetail && selectedPeer}
	<PeerDetail {areaID} {position} peer={selectedPeer} networkID={selectedPeerNetworkID} {highlightLishID} onBack={handleDetailBack} />
{:else}
	<div class="network-page">
		<div class="container">
			<ButtonBar basePosition={[0, 0]}>
				<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} width="auto" />
				<Button icon="/img/restart.svg" label={$t('common.refresh')} onConfirm={refreshActive} width="auto" />
			</ButtonBar>

			<Tabs tabs={tabDefs} bind:activeID={activeTab} position={[0, 1]} onChange={handleTabChange} />

			{#if activeTab === 'lishs'}
				<div class="filters">
					<Input bind:value={lishQuery} placeholder={$t('network.searchLishsPlaceholder')} fontSize="2vh" padding="1vh 1.5vh" position={[0, 2]} />
					<Button icon="/img/search.svg" label={$t('common.search')} onConfirm={startLishSearch} position={[1, 2]} width="auto" disabled={searching || lishQuery.trim().length === 0} />
					{#if searching}
						<Button icon="/img/cross.svg" label={$t('common.cancel')} onConfirm={cancelLishSearch} position={[2, 2]} width="auto" />
					{/if}
				</div>
				{#if searchError}
					<Alert type="error" message={searchError} />
				{:else if searching && searchResults.length === 0}
					<div class="search-status">
						<Spinner size="3vh" />
						<span>{$t('network.searching')}</span>
					</div>
				{:else if !searching && searchResults.length === 0 && searchID !== null}
					<Alert type="warning" message={$t('network.noResults')} />
				{:else if searchResults.length > 0}
					<div class="search-status">
						{#if searching}<Spinner size="2vh" />{/if}
						<span>{$t('network.lishCount', { count: String(searchResults.length) })}</span>
					</div>
					<Table columns="auto 2fr 1fr 12vh 10vh" columnsMobile="1fr auto">
						<TableHeader>
							<TableCell desktopOnly>#</TableCell>
							<TableCell>{$t('network.lishID')}</TableCell>
							<TableCell>{$t('common.name')}</TableCell>
							<TableCell align="center">{$t('network.totalSize')}</TableCell>
							<TableCell align="center">{$t('network.peerCount')}</TableCell>
						</TableHeader>
						{#each searchResults as row, i (row.id)}
							<TableRow position={[0, 3 + i]} onConfirm={() => openPeersPopup(row)}>
								<TableCell desktopOnly>{i + 1}</TableCell>
								<TableCell><span class="lish-id">{row.id}</span></TableCell>
								<TableCell><span class="lish-name">{row.name ?? $t('network.unnamed')}</span></TableCell>
								<TableCell align="center">{row.totalSize !== undefined ? formatSize(row.totalSize) : '—'}</TableCell>
								<TableCell align="center">{row.peers.length}</TableCell>
							</TableRow>
						{/each}
					</Table>
				{/if}
			{:else}
				<!-- ============== Peers tab ============== -->
				{#if nodeInfo}
					<NodeInfoRow {nodeInfo} rowY={2} />
				{/if}
				{#if peersLoading}
					<Spinner size="8vh" />
				{:else if peersError}
					<Alert type="error" message={peersError} />
				{:else if peers.length === 0}
					<Alert type="warning" message={$t('network.noPeers')} />
				{:else}
					{@const baseY = nodeInfo ? 3 : 2}
					<div class="filters">
						<Input bind:value={peersSearch} placeholder={$t('network.searchPlaceholder')} fontSize="2vh" padding="1vh 1.5vh" position={[0, baseY]} />
						<Select bind:value={selectedNetworkID} fontSize="2vh" padding="1vh 1.5vh" position={[1, baseY]}>
							<SelectOption value="" label={$t('network.allNetworks')} />
							{#each networks as net}
								<SelectOption value={net.networkID} label={net.name} />
							{/each}
						</Select>
					</div>
					<Table columns="auto 1fr 30vh 15vh" columnsMobile="1fr auto">
						<TableHeader>
							<TableCell desktopOnly>#</TableCell>
							<TableCell>{$t('network.peerID')}</TableCell>
							<TableCell align="center">{$t('network.network')}</TableCell>
							<TableCell align="center">{$t('network.connections')}</TableCell>
						</TableHeader>
						{#each filteredPeers as peer, i}
							<TableRow position={[0, (nodeInfo ? 3 : 2) + 1 + i]} onConfirm={() => openPeerDetailFromPeersTab(peer)}>
								<TableCell desktopOnly>{i + 1}</TableCell>
								<TableCell><span class="peer-id">{peer.peerID}</span></TableCell>
								<TableCell align="center"><span class="networks-col">{getNetworkNames(peer)}</span></TableCell>
								<TableCell align="center">
									<div class="connections">
										{#if peer.direct > 0}<div>{$t('network.direct', { count: String(peer.direct) })}</div>{/if}
										{#if peer.relay > 0}<div>{$t('network.relayed', { count: String(peer.relay) })}</div>{/if}
									</div>
								</TableCell>
							</TableRow>
						{/each}
					</Table>
				{/if}
			{/if}
		</div>
	</div>

	{#if peersPopupRow}
		{@const popupRow = peersPopupRow}
		<div class="popup-backdrop" role="button" tabindex="-1" onclick={closePeersPopup} onkeydown={closePeersPopup}>
			<div class="popup" role="dialog" aria-modal="true" tabindex="-1" onclick={stopPropagation} onkeydown={stopPropagation}>
				<div class="popup-title">{popupRow.name ?? $t('network.unnamed')}</div>
				<div class="popup-subtitle">{popupRow.id}</div>
				<div class="popup-title">{$t('network.peersWithLish')}</div>
				<Table columns="auto 1fr 12vh">
					<TableHeader>
						<TableCell desktopOnly>#</TableCell>
						<TableCell>{$t('network.peerID')}</TableCell>
						<TableCell align="center">{$t('network.network')}</TableCell>
					</TableHeader>
					{#each popupRow.peers as p, i}
						<TableRow position={[0, 100 + i]} onConfirm={() => openPeerFromSearchPopup(p.peerID, p.networkID, popupRow.id)}>
							<TableCell desktopOnly>{i + 1}</TableCell>
							<TableCell><span class="peer-id">{p.peerID}</span></TableCell>
							<TableCell align="center">{networks.find(n => n.networkID === p.networkID)?.name ?? p.networkID}</TableCell>
						</TableRow>
					{/each}
				</Table>
				<ButtonBar basePosition={[0, 200]}>
					<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={closePeersPopup} width="auto" />
				</ButtonBar>
			</div>
		</div>
	{/if}
{/if}
