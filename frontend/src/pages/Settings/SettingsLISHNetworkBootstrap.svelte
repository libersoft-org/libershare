<script lang="ts">
	import { t, translateError, tt } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea, type NavPos } from '../../scripts/navArea.svelte.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { type BootstrapStatus, type BootstrapPeerStatus, type LISHNetworkConfig } from '@shared';
	import { productNetworkList } from '@shared';
	import { api } from '../../scripts/api.ts';
	import { fetchPublicNetworks } from '../../scripts/lishNetwork.ts';
	import Button from '../../components/Buttons/Button.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import Icon from '../../components/Icon/Icon.svelte';
	import Table from '../../components/Table/Table.svelte';
	import TableHeader from '../../components/Table/TableHeader.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
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

	const STATUS_ICONS: Record<BootstrapPeerStatus['status'], string> = {
		connected: '/img/check.svg',
		pending: '/img/info.svg',
		'identity-mismatch': '/img/warning.svg',
		timeout: '/img/cross.svg',
		error: '/img/cross.svg',
	};
	const STATUS_COLORS: Record<BootstrapPeerStatus['status'], string> = {
		connected: '--color-success',
		pending: '--color-info',
		'identity-mismatch': '--color-warning',
		timeout: '--color-error',
		error: '--color-error',
	};

	function isProblem(p: BootstrapPeerStatus): boolean {
		return p.status === 'identity-mismatch' || p.status === 'timeout' || p.status === 'error';
	}

	let problemPeers = $derived((status?.peers ?? []).filter(p => p.origin === 'configured' && isProblem(p)));
	let totalConfigured = $derived((status?.peers ?? []).filter(p => p.origin === 'configured').length || network.bootstrapPeers.length);
	let backPos = $derived<NavPos>([0, problemPeers.length + 2]);

	function short(s: string | null | undefined, head: number = 14, tail: number = 6): string {
		if (!s) return '—';
		if (s.length <= head + tail + 2) return s;
		return `${s.slice(0, head)}…${s.slice(-tail)}`;
	}

	function statusLabel(p: BootstrapPeerStatus): string {
		switch (p.status) {
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

	async function replaceWithActual(peer: BootstrapPeerStatus): Promise<void> {
		if (!peer.actualPeerID || !peer.expectedPeerID) return;
		busy = true;
		try {
			const updated = network.bootstrapPeers.map(addr => (addr === peer.multiaddr ? addr.replace(peer.expectedPeerID!, peer.actualPeerID!) : addr));
			const next = await api.lishnets.updateBootstrapPeers(network.networkID, updated);
			onUpdated?.(next);
			network = next;
		} catch (e) {
			addNotification(translateError(e), 'error');
		} finally {
			busy = false;
		}
	}

	async function removeEntry(peer: BootstrapPeerStatus): Promise<void> {
		busy = true;
		try {
			const updated = network.bootstrapPeers.filter(addr => addr !== peer.multiaddr);
			const next = await api.lishnets.updateBootstrapPeers(network.networkID, updated);
			onUpdated?.(next);
			network = next;
		} catch (e) {
			addNotification(translateError(e), 'error');
		} finally {
			busy = false;
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

	const _navHandle = createNavArea(() => ({ areaID, position, onBack, activate: true }));
	void _navHandle;
</script>

<style>
	.bootstrap-page {
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
		color: var(--secondary-foreground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		display: block;
	}
</style>

<div class="bootstrap-page" data-testid="bootstrap-page-{network.networkID}">
	<div class="container">
		<ButtonBar basePosition={[0, 0]}>
			<Button icon="/img/online.svg" label={$t('settings.lishNetwork.bootstrap.refreshFromList')} padding="1vh 1.5vh" fontSize="1.6vh" disabled={busy} onConfirm={refreshFromPublicList} />
		</ButtonBar>
		{#if problemPeers.length === 0}
			<Alert type="info" message={$t('settings.lishNetwork.bootstrap.noProblems')} />
		{:else}
			<Alert type="warning" message={tt(problemPeers.length === 1 ? 'settings.lishNetwork.bootstrap.warningOne' : 'settings.lishNetwork.bootstrap.warningMany', { count: String(problemPeers.length), total: String(totalConfigured) })} />
			<Table columns="3vh 1fr 1fr 28vh" columnsMobile="auto 1fr">
				<TableHeader>
					<TableCell>·</TableCell>
					<TableCell>{$t('settings.lishNetwork.bootstrap.colPeer')}</TableCell>
					<TableCell>{$t('settings.lishNetwork.bootstrap.colAddress')}</TableCell>
					<TableCell align="right">{$t('settings.lishNetwork.bootstrap.colActions')}</TableCell>
				</TableHeader>
				{#each problemPeers as peer, i (peer.expectedPeerID ?? peer.multiaddr)}
					<TableRow>
						<TableCell>
							<Icon img={STATUS_ICONS[peer.status]} size="2vh" padding="0" colorVariable={STATUS_COLORS[peer.status]} alt={statusLabel(peer)} />
						</TableCell>
						<TableCell>
							<span class="peer-id" title={peer.expectedPeerID ?? ''} data-testid="bootstrap-peer-{network.networkID}-{peer.expectedPeerID ?? peer.multiaddr}" data-status={peer.status} data-origin={peer.origin}>{short(peer.expectedPeerID)}</span>
						</TableCell>
						<TableCell>
							<span class="host" title={peer.multiaddr}>{peer.multiaddr.replace(/\/p2p\/.*$/, '')}</span>
						</TableCell>
						<TableCell align="right">
							<ButtonBar basePosition={[0, i + 1]} wrap={false} justify="flex-end" gap="0.8vh">
								{#if peer.status === 'identity-mismatch' && peer.actualPeerID && peer.expectedPeerID}
									<Button icon="/img/check.svg" label={$t('settings.lishNetwork.bootstrap.replaceShort')} padding="0.6vh 1.2vh" fontSize="1.5vh" disabled={busy} onConfirm={() => replaceWithActual(peer)} />
								{/if}
								<Button icon="/img/del.svg" label={$t('settings.lishNetwork.bootstrap.removeShort')} padding="0.6vh 1.2vh" fontSize="1.5vh" disabled={busy} onConfirm={() => removeEntry(peer)} />
							</ButtonBar>
						</TableCell>
					</TableRow>
				{/each}
			</Table>
		{/if}
		<Button icon="/img/back.svg" label={$t('common.back')} position={backPos} onConfirm={onBack} />
	</div>
</div>
