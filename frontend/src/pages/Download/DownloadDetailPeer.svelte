<script lang="ts">
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { t } from '../../scripts/language.ts';
	import { peerDetails, type PeerDetail } from '../../scripts/downloads.ts';
	import { copyToClipboard } from '../../scripts/clipboard.ts';
	import { formatSize } from '../../scripts/utils.ts';
	import { onMount } from 'svelte';
	import Dialog from '../../components/Dialog/Dialog.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	interface Props {
		/** LISH the peer belongs to — used to look the peer up in the live store. */
		lishID: string;
		/** Stable peer ID value (not index) captured at open time. */
		peerID: string;
		/** Snapshot of the peer at open time — shown if the peer is pruned from the store. */
		initialPeer: PeerDetail;
		position: Position;
		onBack: () => void;
	}
	let { lishID, peerID, initialPeer, position, onBack }: Props = $props();
	// Live ticking clock for "last activity" / "connected" relative times.
	let now = $state(Date.now());
	// Look the peer up by its stable ID. Sorting/pruning may reorder the list, so we never
	// rely on an index — only the peerID value identifies the peer across store updates.
	let livePeer = $derived(($peerDetails.get(lishID) ?? []).find(p => p.peerID === peerID));
	// When the peer is pruned from the store we keep showing the last known snapshot.
	let pruned = $derived(livePeer === undefined);
	let peer = $derived(livePeer ?? initialPeer);
	let lastActivityAgo = $derived(peer.lastActivity ? Math.max(0, Math.round((now - peer.lastActivity) / 1000)) : 0);
	let connectedAgo = $derived(peer.connectedAt ? Math.max(0, Math.round((now - peer.connectedAt) / 1000)) : 0);

	function handleCopy(): void {
		copyToClipboard(peerID, $t('downloads.peerDetail.peerIDCopied'));
	}

	createNavArea(() => ({
		areaID: 'peer-detail-dialog',
		position,
		activate: true,
		trap: true,
		onBack,
	}));

	onMount(() => {
		const clock = setInterval(() => {
			now = Date.now();
		}, 1000);
		return () => clearInterval(clock);
	});
</script>

<style>
	.peer-detail {
		display: flex;
		flex-direction: column;
		gap: 2vh;
		min-width: 50vh;
		max-width: 80vh;
	}

	.peer-id-block {
		display: flex;
		flex-direction: column;
		gap: 0.5vh;
	}

	.peer-id-label {
		font-size: 1.6vh;
		color: var(--secondary-foreground);
	}

	.peer-id-value {
		font-family: var(--font-mono);
		font-size: 1.8vh;
		color: var(--primary-foreground);
		word-break: break-all;
		white-space: normal;
		line-height: 1.5;
	}

	.rows {
		display: flex;
		flex-direction: column;
		gap: 0.8vh;
		font-size: 1.7vh;
	}

	.row {
		display: flex;
		justify-content: space-between;
		gap: 2vh;
	}

	.row .label {
		color: var(--secondary-foreground);
	}

	.row .value {
		text-align: right;
		font-family: var(--font-mono);
	}

	.metric {
		display: inline-flex;
		align-items: center;
		gap: 0.5vh;
	}

	.metric.dl {
		color: var(--mode-download-fg, #0c0);
	}

	.metric.ul {
		color: var(--mode-upload-fg, #28f);
	}

	.stale {
		color: var(--color-warning);
		font-size: 1.5vh;
		text-align: center;
	}

	.pruned {
		color: var(--color-error);
		font-size: 1.5vh;
		text-align: center;
	}
</style>

<Dialog title={$t('downloads.peerDetail.title')}>
	<div class="peer-detail">
		<div class="peer-id-block">
			<span class="peer-id-label">{$t('downloads.peerDetail.peerID')}</span>
			<span class="peer-id-value">{peerID}</span>
		</div>
		{#if pruned}
			<div class="pruned">{$t('downloads.peerDetail.disconnected')}</div>
		{:else if peer.stale}
			<div class="stale">{$t('downloads.peerDetail.stale')}</div>
		{/if}
		<div class="rows">
			<div class="row">
				<span class="label">{$t('downloads.peerDetail.connection')}</span>
				<span class="value">{peer.connectionType}</span>
			</div>
			<div class="row">
				<span class="label">{$t('downloads.peerDetail.availability')}</span>
				<span class="value">{peer.havePercent != null ? `${peer.havePercent}%` : '—'}</span>
			</div>
			<div class="row">
				<span class="label">{$t('downloads.peerDetail.currentFile')}</span>
				<span class="value">{peer.currentFile || '—'}</span>
			</div>
			<div class="row">
				<span class="label">{$t('downloads.peerDetail.downloadSpeed')}</span>
				<span class="value metric dl">{formatSize(peer.downloadSpeed || 0)}/s</span>
			</div>
			<div class="row">
				<span class="label">{$t('downloads.peerDetail.uploadSpeed')}</span>
				<span class="value metric ul">{formatSize(peer.uploadSpeed || 0)}/s</span>
			</div>
			<div class="row">
				<span class="label">{$t('downloads.peerDetail.downloaded')}</span>
				<span class="value metric dl">{formatSize(peer.totalDownloaded || 0)}</span>
			</div>
			<div class="row">
				<span class="label">{$t('downloads.peerDetail.uploaded')}</span>
				<span class="value metric ul">{formatSize(peer.totalUploaded || 0)}</span>
			</div>
			<div class="row">
				<span class="label">{$t('downloads.peerDetail.connectedAt')}</span>
				<span class="value">{$t('downloads.peerDetail.secondsAgo', { seconds: String(connectedAgo) })}</span>
			</div>
			<div class="row">
				<span class="label">{$t('downloads.peerDetail.lastActivity')}</span>
				<span class="value">{$t('downloads.peerDetail.secondsAgo', { seconds: String(lastActivityAgo) })}</span>
			</div>
		</div>
		<ButtonBar justify="center" gap="2vh" basePosition={[0, 0]}>
			<Button icon="/img/copy.svg" label={$t('downloads.peerDetail.copyID')} onConfirm={handleCopy} />
			<Button icon="/img/back.svg" label={$t('downloads.peerDetail.close')} onConfirm={onBack} />
		</ButtonBar>
	</div>
</Dialog>
