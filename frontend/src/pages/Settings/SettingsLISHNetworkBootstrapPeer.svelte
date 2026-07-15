<script lang="ts">
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { type BootstrapPeerStatus, type LISHNetworkConfig } from '@shared';
	import { api } from '../../scripts/api.ts';
	import Button from '../../components/Buttons/Button.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Icon from '../../components/Icon/Icon.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		network: LISHNetworkConfig;
		/** All address entries observed for the same peer identity (one card per address). */
		peers: BootstrapPeerStatus[];
		onUpdated?: ((network: LISHNetworkConfig) => void) | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, network, peers, onUpdated, onBack }: Props = $props();

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
		pending: '--secondary-foreground',
		'identity-mismatch': '--color-warning',
		timeout: '--color-error',
		error: '--color-error',
	};

	let peerID = $derived(peers[0]?.expectedPeerID ?? peers[0]?.actualPeerID ?? null);

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
			onBack?.();
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
			onBack?.();
		} catch (e) {
			addNotification(translateError(e), 'error');
		} finally {
			busy = false;
		}
	}

	const _navHandle = createNavArea(() => ({ areaID, position, onBack, activate: true }));
	void _navHandle;

	function canReplace(peer: BootstrapPeerStatus): boolean {
		return peer.status === 'identity-mismatch' && !!peer.actualPeerID && !!peer.expectedPeerID && peer.origin === 'configured';
	}

	function canRemove(peer: BootstrapPeerStatus): boolean {
		return peer.origin === 'configured' && (peer.status === 'identity-mismatch' || peer.status === 'timeout' || peer.status === 'error');
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
		overflow-y: auto;
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 1.5vh;
		width: 1200px;
		max-width: 100%;
	}

	.detail-row {
		display: flex;
		flex-direction: column;
		gap: 0.5vh;
		padding: 1.5vh 2vh;
		background-color: var(--secondary-soft-background);
		border: 0.2vh solid var(--secondary-softer-background);
		border-radius: 1vh;
		font-size: 1.8vh;
	}

	.detail-label {
		font-size: 1.5vh;
		color: var(--secondary-foreground);
		text-transform: uppercase;
		letter-spacing: 0.1vh;
	}

	.detail-value {
		font-family: var(--font-mono);
		word-break: break-all;
		color: var(--primary-foreground);
	}

	.entry {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		padding: 1.5vh 2vh;
		background-color: var(--secondary-soft-background);
		border: 0.2vh solid var(--secondary-softer-background);
		border-left-width: 0.6vh;
		border-radius: 1vh;
	}

	.entry-head {
		display: flex;
		align-items: center;
		gap: 1vh;
		font-size: 1.8vh;
	}

	.entry-status {
		font-weight: bold;
	}

	.entry-error {
		color: var(--secondary-foreground);
		font-size: 1.6vh;
	}

	.entry-origin {
		margin-left: auto;
		color: var(--secondary-foreground);
		font-size: 1.5vh;
		text-transform: uppercase;
		letter-spacing: 0.1vh;
		white-space: nowrap;
	}

	.entry-address {
		font-family: var(--font-mono);
		font-size: 1.7vh;
		word-break: break-all;
		color: var(--primary-foreground);
	}

	.entry-meta {
		display: flex;
		gap: 1vh;
		font-size: 1.6vh;
	}

	.entry-meta .detail-label {
		white-space: nowrap;
	}

	.entry-meta .detail-value {
		font-size: 1.6vh;
	}
</style>

<div class="page" data-testid="bootstrap-peer-detail-{peers[0]?.multiaddr}">
	<div class="container">
		{#if peerID}
			<div class="detail-row">
				<div class="detail-label">{$t('settings.lishNetwork.bootstrap.colPeer')}</div>
				<div class="detail-value">{peerID}</div>
			</div>
		{/if}
		{#each peers as peer, i (peer.multiaddr)}
			<div class="entry" style="border-left-color: var({STATUS_COLORS[peer.status]});">
				<div class="entry-head">
					<Icon img={STATUS_ICONS[peer.status]} size="2.2vh" padding="0" colorVariable={STATUS_COLORS[peer.status]} alt={statusLabel(peer)} />
					<span class="entry-status" style="color: var({STATUS_COLORS[peer.status]});">{statusLabel(peer)}</span>
					{#if peer.lastError}
						<span class="entry-error">{peer.lastError}</span>
					{/if}
					<span class="entry-origin">{peer.origin === 'configured' ? $t('settings.lishNetwork.bootstrap.originConfigured') : $t('settings.lishNetwork.bootstrap.originDiscovered')}</span>
				</div>
				<div class="entry-address">{peer.multiaddr}</div>
				{#if peer.actualPeerID && peer.actualPeerID !== peerID}
					<div class="entry-meta">
						<span class="detail-label">{$t('settings.lishNetwork.bootstrap.actualPeerIDLabel')}</span>
						<span class="detail-value">{peer.actualPeerID}</span>
					</div>
				{/if}
				{#if canReplace(peer) || canRemove(peer)}
					<ButtonBar basePosition={[0, i]}>
						{#if canReplace(peer)}
							<Button icon="/img/edit.svg" label={$t('settings.lishNetwork.bootstrap.replaceWithActual')} padding="1vh 1.5vh" fontSize="1.6vh" disabled={busy} onConfirm={() => replaceWithActual(peer)} />
						{/if}
						{#if canRemove(peer)}
							<Button icon="/img/del.svg" label={$t('settings.lishNetwork.bootstrap.removeEntry')} padding="1vh 1.5vh" fontSize="1.6vh" disabled={busy} onConfirm={() => removeEntry(peer)} />
						{/if}
					</ButtonBar>
				{/if}
			</div>
		{/each}
		<ButtonBar basePosition={[0, peers.length]}>
			<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} />
		</ButtonBar>
	</div>
</div>
