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
	import Alert from '../../components/Alert/Alert.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		network: LISHNetworkConfig;
		/** All address entries observed for the same peer identity (one detail section per address). */
		peers: BootstrapPeerStatus[];
		onUpdated?: ((network: LISHNetworkConfig) => void) | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, network, peers, onUpdated, onBack }: Props = $props();

	let busy = $state(false);

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

	function alertType(p: BootstrapPeerStatus): 'info' | 'warning' | 'error' {
		if (p.status === 'identity-mismatch') return 'warning';
		if (p.status === 'timeout' || p.status === 'error') return 'error';
		return 'info';
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
		gap: 2vh;
		width: 1200px;
		max-width: 100%;
	}

	.entry {
		display: flex;
		flex-direction: column;
		gap: 2vh;
	}

	.entry + .entry {
		border-top: 0.2vh solid var(--secondary-softer-background);
		padding-top: 2vh;
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
</style>

<div class="page" data-testid="bootstrap-peer-detail-{peers[0]?.multiaddr}">
	<div class="container">
		{#each peers as peer, i (peer.multiaddr)}
			<div class="entry">
				<Alert type={alertType(peer)} message="{statusLabel(peer)}{peer.lastError ? ' — ' + peer.lastError : ''}" />
				<div class="detail-row">
					<div class="detail-label">{$t('settings.lishNetwork.bootstrap.colAddress')}</div>
					<div class="detail-value">{peer.multiaddr}</div>
				</div>
				{#if peer.expectedPeerID}
					<div class="detail-row">
						<div class="detail-label">{$t('settings.lishNetwork.bootstrap.expectedPeerID')}</div>
						<div class="detail-value">{peer.expectedPeerID}</div>
					</div>
				{/if}
				{#if peer.actualPeerID}
					<div class="detail-row">
						<div class="detail-label">{$t('settings.lishNetwork.bootstrap.actualPeerIDLabel')}</div>
						<div class="detail-value">{peer.actualPeerID}</div>
					</div>
				{/if}
				<div class="detail-row">
					<div class="detail-label">{$t('settings.lishNetwork.bootstrap.colOrigin')}</div>
					<div class="detail-value">{peer.origin === 'configured' ? $t('settings.lishNetwork.bootstrap.originConfigured') : $t('settings.lishNetwork.bootstrap.originDiscovered')}</div>
				</div>
				{#if canReplace(peer) || canRemove(peer)}
					<ButtonBar basePosition={[0, i]}>
						{#if canReplace(peer)}
							<Button icon="/img/edit.svg" label={$t('settings.lishNetwork.bootstrap.replaceWithActual')} disabled={busy} onConfirm={() => replaceWithActual(peer)} />
						{/if}
						{#if canRemove(peer)}
							<Button icon="/img/del.svg" label={$t('settings.lishNetwork.bootstrap.removeEntry')} disabled={busy} onConfirm={() => removeEntry(peer)} />
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
