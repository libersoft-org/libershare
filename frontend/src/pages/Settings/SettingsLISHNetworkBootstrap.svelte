<script lang="ts">
	import { t, translateError, tt } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea, type NavPos } from '../../scripts/navArea.svelte.ts';
	import { createSubPage } from '../../scripts/subPage.svelte.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { type BootstrapStatus, type BootstrapPeerStatus, type LISHNetworkConfig } from '@shared';
	import { productNetworkList } from '@shared';
	import { api } from '../../scripts/api.ts';
	import { fetchPublicNetworks } from '../../scripts/lishNetwork.ts';
	import Button from '../../components/Buttons/Button.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import Icon from '../../components/Icon/Icon.svelte';
	import Input from '../../components/Input/Input.svelte';
	import Select from '../../components/Input/Select.svelte';
	import SelectOption from '../../components/Input/SelectOption.svelte';
	import Table from '../../components/Table/Table.svelte';
	import TableHeader from '../../components/Table/TableHeader.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	import LISHNetworkBootstrapPeer from './SettingsLISHNetworkBootstrapPeer.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		network: LISHNetworkConfig;
		status: BootstrapStatus | undefined;
		onUpdated?: ((network: LISHNetworkConfig) => void) | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, network, status, onUpdated, onBack }: Props = $props();

	let busy = $state(false);
	let search = $state('');
	let filter = $state<'all' | 'problems' | 'configured' | 'discovered'>('all');
	const PAGE_SIZE = 50;
	let pageSize = $state(PAGE_SIZE);

	const STATUS_ICONS: Record<BootstrapPeerStatus['status'], string> = {
		connected: '/img/check.svg',
		pending: '/img/info.svg',
		'identity-mismatch': '/img/warning.svg',
		timeout: '/img/cross.svg',
		error: '/img/cross.svg',
	};
	const STATUS_COLORS: Record<BootstrapPeerStatus['status'], string> = {
		connected: '--color-success',
		pending: '--secondary-foreground',
		'identity-mismatch': '--color-warning',
		timeout: '--color-error',
		error: '--color-error',
	};
	/** Lower rank = healthier; a group of addresses reports its healthiest status. */
	const STATUS_RANK: Record<BootstrapPeerStatus['status'], number> = {
		connected: 0,
		pending: 1,
		'identity-mismatch': 2,
		timeout: 3,
		error: 4,
	};

	/** One table row: all address entries observed for the same peer identity. */
	interface PeerGroup {
		key: string;
		peerID: string | null;
		entries: BootstrapPeerStatus[];
	}

	function isProblem(p: BootstrapPeerStatus): boolean {
		return p.status === 'identity-mismatch' || p.status === 'timeout' || p.status === 'error';
	}

	let allPeers = $derived(status?.peers ?? []);
	let configuredCount = $derived(allPeers.filter(p => p.origin === 'configured').length || network.bootstrapPeers.length);
	let problemCount = $derived(allPeers.filter(p => p.origin === 'configured' && isProblem(p)).length);

	let filteredPeers = $derived.by(() => {
		const q = search.trim().toLowerCase();
		let out = allPeers;
		if (filter === 'configured') out = out.filter(p => p.origin === 'configured');
		else if (filter === 'discovered') out = out.filter(p => p.origin === 'discovered');
		else if (filter === 'problems') out = out.filter(isProblem);
		if (q) out = out.filter(p => p.multiaddr.toLowerCase().includes(q) || (p.expectedPeerID ?? '').toLowerCase().includes(q) || (p.actualPeerID ?? '').toLowerCase().includes(q));
		return out;
	});
	let groupedPeers = $derived.by(() => {
		const groups = new Map<string, PeerGroup>();
		for (const p of filteredPeers) {
			const key = p.expectedPeerID ?? p.actualPeerID ?? p.multiaddr;
			let g = groups.get(key);
			if (!g) groups.set(key, (g = { key, peerID: p.expectedPeerID ?? p.actualPeerID, entries: [] }));
			g.entries.push(p);
		}
		return [...groups.values()];
	});
	let pagedGroups = $derived(groupedPeers.slice(0, pageSize));
	let hasMore = $derived(groupedPeers.length > pageSize);
	let showMorePos = $derived<NavPos>([0, pagedGroups.length + 2]);
	let backPos = $derived<NavPos>([0, pagedGroups.length + 2 + (hasMore ? 1 : 0)]);

	function groupStatus(g: PeerGroup): BootstrapPeerStatus['status'] {
		return g.entries.reduce((best, p) => (STATUS_RANK[p.status] < STATUS_RANK[best] ? p.status : best), g.entries[0]!.status);
	}

	function groupOrigins(g: PeerGroup): BootstrapPeerStatus['origin'][] {
		return [...new Set(g.entries.map(p => p.origin))];
	}

	function short(s: string | null | undefined, head: number = 14, tail: number = 6): string {
		if (!s) return '—';
		if (s.length <= head + tail + 2) return s;
		return `${s.slice(0, head)}…${s.slice(-tail)}`;
	}

	function statusLabel(status: BootstrapPeerStatus['status']): string {
		switch (status) {
			case 'connected':
				return $t('settings.lishNetwork.bootstrap.connected');
			case 'pending':
				return $t('settings.lishNetwork.bootstrap.pending');
			case 'identity-mismatch':
				return $t('settings.lishNetwork.bootstrap.identityMismatch');
			case 'timeout':
				return $t('settings.lishNetwork.bootstrap.timeout');
			case 'error':
				return $t('settings.lishNetwork.bootstrap.error');
		}
	}

	async function refreshFromPublicList(): Promise<void> {
		busy = true;
		try {
			const result = await fetchPublicNetworks(productNetworkList);
			if (result.error) {
				addNotification(tt('settings.lishNetwork.bootstrap.refreshFailed', { detail: result.error }), 'error');
				return;
			}
			const match = result.networks.find(n => n.networkID === network.networkID);
			if (!match) {
				addNotification($t('settings.lishNetwork.bootstrap.refreshNoMatch'), 'warning');
				return;
			}
			const next = await api.lishnets.updateBootstrapPeers(network.networkID, match.bootstrapPeers);
			onUpdated?.(next);
			network = next;
			addNotification($t('settings.lishNetwork.bootstrap.refreshSuccess'), 'success');
		} catch (e) {
			addNotification(translateError(e), 'error');
		} finally {
			busy = false;
		}
	}

	const navHandle = createNavArea(() => ({ areaID, position, onBack, activate: true }));
	const peerSubPage = createSubPage(navHandle, () => areaID);
	let selectedGroup = $state<PeerGroup | null>(null);

	function openPeerDetail(group: PeerGroup): void {
		selectedGroup = group;
		peerSubPage.enter(short(group.peerID), () => void closePeerDetail());
	}

	async function closePeerDetail(): Promise<void> {
		selectedGroup = null;
		await peerSubPage.exit();
	}
</script>

<style>
	.page {
		display: flex;
		flex-direction: column;
		align-items: center;
		flex: 1;
		min-height: 0;
		padding: 2vh;
		gap: 2vh;
		/* Page itself MUST NOT scroll. If it did, scrollIntoView on a row
		 * would move the whole page (including filter bar) under the mouse,
		 * which then triggers a new mouseover on a different row, causing
		 * the cursor to "drag" selection up/down on every keyboard move. */
		overflow: hidden;
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 2vh;
		width: 1200px;
		max-width: 100%;
		flex: 1;
		min-height: 0;
	}

	/* The Table is the scrollable region inside .container. Keyboard navigation
	 * scrolls only the table viewport; the filter bar / refresh button / Zpět
	 * button stay anchored and the cursor doesn't slide over moving rows. */
	.container :global(.table) {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
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
		font-size: 1.6vh;
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.host {
		font-family: var(--font-mono);
		font-size: 1.6vh;
		color: inherit;
		opacity: 0.75;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		display: block;
	}

	.addresses {
		display: flex;
		flex-direction: column;
		gap: 0.3vh;
		min-width: 0;
	}

	.address-line {
		display: flex;
		align-items: center;
		gap: 0.6vh;
		min-width: 0;
	}

	.address-line .host {
		flex: 1;
		min-width: 0;
	}
</style>

{#if peerSubPage.active && selectedGroup}
	<LISHNetworkBootstrapPeer {areaID} {position} {network} peers={selectedGroup.entries} {onUpdated} onBack={() => void closePeerDetail()} />
{:else}
	<div class="page" data-testid="bootstrap-page-{network.networkID}">
		<div class="container">
			<ButtonBar basePosition={[0, 0]}>
				<Button icon="/img/online.svg" label={$t('settings.lishNetwork.bootstrap.refreshFromList')} padding="1vh 1.5vh" fontSize="1.6vh" disabled={busy} onConfirm={refreshFromPublicList} />
			</ButtonBar>
			{#if problemCount > 0}
				<Alert type="warning" message={tt(problemCount === 1 ? 'settings.lishNetwork.bootstrap.warningOne' : 'settings.lishNetwork.bootstrap.warningMany', { count: String(problemCount), total: String(configuredCount) })} />
			{/if}
			<div class="filters">
				<Input bind:value={search} placeholder={$t('settings.lishNetwork.bootstrap.searchPlaceholder')} fontSize="2vh" padding="1vh 1.5vh" position={[0, 1]} />
				<Select bind:value={filter} fontSize="2vh" padding="1vh 1.5vh" position={[1, 1]}>
					<SelectOption value="all" label={$t('settings.lishNetwork.bootstrap.filterAll')} />
					<SelectOption value="configured" label={$t('settings.lishNetwork.bootstrap.filterConfigured')} />
					<SelectOption value="discovered" label={$t('settings.lishNetwork.bootstrap.filterDiscovered')} />
					<SelectOption value="problems" label={$t('settings.lishNetwork.bootstrap.filterProblems')} />
				</Select>
			</div>
			{#if filteredPeers.length === 0}
				<Alert type="info" message={$t('settings.lishNetwork.bootstrap.noMatch')} />
			{:else}
				<Table columns="3vh 1fr 1fr 14vh" columnsMobile="auto 1fr">
					<TableHeader>
						<TableCell>·</TableCell>
						<TableCell>{$t('settings.lishNetwork.bootstrap.colPeer')}</TableCell>
						<TableCell>{$t('settings.lishNetwork.bootstrap.colAddress')}</TableCell>
						<TableCell align="center">{$t('settings.lishNetwork.bootstrap.colOrigin')}</TableCell>
					</TableHeader>
					{#each pagedGroups as group, i (group.key)}
						<TableRow position={[0, i + 2]} onConfirm={() => openPeerDetail(group)}>
							<TableCell>
								<Icon img={STATUS_ICONS[groupStatus(group)]} size="2vh" padding="0" colorVariable={STATUS_COLORS[groupStatus(group)]} alt={statusLabel(groupStatus(group))} />
							</TableCell>
							<TableCell>
								<span class="peer-id" title={group.peerID ?? ''} data-testid="bootstrap-peer-{network.networkID}-{group.key}" data-status={groupStatus(group)} data-origin={groupOrigins(group).join(',')}>{short(group.peerID)}</span>
							</TableCell>
							<TableCell>
								<div class="addresses">
									{#each group.entries as peer (peer.multiaddr)}
										<div class="address-line">
											{#if group.entries.length > 1}
												<Icon img={STATUS_ICONS[peer.status]} size="1.6vh" padding="0" colorVariable={STATUS_COLORS[peer.status]} alt={statusLabel(peer.status)} />
											{/if}
											<span class="host" title={peer.multiaddr}>{peer.multiaddr.replace(/\/p2p\/.*$/, '')}</span>
										</div>
									{/each}
								</div>
							</TableCell>
							<TableCell align="center"
								>{groupOrigins(group)
									.map(origin => (origin === 'configured' ? $t('settings.lishNetwork.bootstrap.originConfigured') : $t('settings.lishNetwork.bootstrap.originDiscovered')))
									.join(', ')}</TableCell
							>
						</TableRow>
					{/each}
				</Table>
				{#if hasMore}
					<Button icon="/img/down.svg" label={tt('settings.lishNetwork.bootstrap.showMore', { count: String(Math.min(PAGE_SIZE, groupedPeers.length - pageSize)), total: String(groupedPeers.length - pageSize) })} padding="1vh 1.5vh" fontSize="1.6vh" position={showMorePos} onConfirm={() => (pageSize += PAGE_SIZE)} />
				{/if}
			{/if}
			<Button icon="/img/back.svg" label={$t('common.back')} position={backPos} onConfirm={onBack} />
		</div>
	</div>
{/if}
