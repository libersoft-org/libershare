<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { api } from '../../scripts/api.ts';
	import { withPeerFallback, type PeerAttemptStatus } from '../../scripts/peerFallback.ts';
	import { formatSize } from '../../scripts/utils.ts';
	import { type LishSearchResult, type LISHNetworkConfig, type IPeerLishDetail, type ManifestProgressEvent } from '@shared';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Icon from '../../components/Icon/Icon.svelte';
	import ProgressBar from '../../components/ProgressBar/ProgressBar.svelte';
	import Table from '../../components/Table/Table.svelte';
	import TableHeader from '../../components/Table/TableHeader.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	import NetworkLishDetailView from './NetworkLishDetailView.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		row: LishSearchResult;
		networks: LISHNetworkConfig[];
		onBack: () => void;
		onOpenPeer: (peerID: string, networkID: string, lishID: string) => void;
	}
	let { areaID, position = LAYOUT.content, row, networks, onBack, onOpenPeer }: Props = $props();

	let adding = $state(false);
	let loadingDetail = $state(false);
	// Add and Details share the peer-fallback loop and its per-row status column, so they
	// must not run concurrently — one finishing would clear/overwrite the other's state.
	let busy = $derived(adding || loadingDetail);
	let detail = $state<IPeerLishDetail | null>(null);
	// Fallback progress per peer row (indexed like row.peers); outcomes persist until the next run.
	let peerStatuses = $state<Array<PeerAttemptStatus | null>>([]);
	// Real manifest-transfer progress per peer row, fed by the backend
	// `lishnets:manifestProgress` event and shown only while the row is 'downloading'.
	// Raw byte counts rather than a percentage — the row shows both, and the bar derives from them.
	let peerTransfer = $state<Array<{ received: number; total: number }>>([]);

	/** Manifest transfer completion (0–100) for a peer row; 0 until the total size is known. */
	function transferPercent(transfer?: { received: number; total: number }): number {
		if (!transfer || transfer.total <= 0) return 0;
		return Math.min(100, (transfer.received / transfer.total) * 100);
	}

	/**
	 * True once the manifest bytes are all in. The peer stays 'downloading' past this point
	 * while the backend parses the manifest and writes its chunks — seconds of apparent
	 * standstill on a large LISH, so the row says it is processing rather than still transferring.
	 */
	function isTransferred(transfer?: { received: number; total: number }): boolean {
		return !!transfer && transfer.total > 0 && transfer.received >= transfer.total;
	}

	let offManifestProgress: (() => void) | void;
	onMount(() => {
		// Best-effort: with the WS down the call rejects — swallow it, the event just stays unsubscribed.
		api.subscribe('lishnets:manifestProgress').catch(() => {});
		offManifestProgress = api.on('lishnets:manifestProgress', (d: ManifestProgressEvent) => {
			if (d.lishID !== row.id) return;
			const idx = row.peers.findIndex(p => p.peerID === d.peerID);
			if (idx >= 0 && peerStatuses[idx] === 'downloading') peerTransfer[idx] = { received: d.received, total: d.total };
		});
	});
	onDestroy(() => {
		offManifestProgress?.();
		api.unsubscribe('lishnets:manifestProgress').catch(() => {});
	});

	function networkName(networkID: string): string {
		return networks.find(n => n.networkID === networkID)?.name ?? networkID;
	}

	function makeOpenHandler(peerID: string, networkID: string): () => void {
		return () => onOpenPeer(peerID, networkID, row.id);
	}

	/** Run the shared peer-fallback loop over this row's peers, driving the per-row statuses. */
	function tryPeers<T>(op: (peerID: string, networkID: string) => Promise<T>): Promise<T> {
		peerStatuses = [];
		peerTransfer = [];
		return withPeerFallback(row.peers, op, (index, status) => {
			peerStatuses[index] = status;
			// Reset the row's real progress bar as each new attempt starts.
			if (status === 'downloading') peerTransfer[index] = { received: 0, total: 0 };
		});
	}

	async function handleAddToSharing(): Promise<void> {
		if (busy || row.peers.length === 0) return;
		adding = true;
		try {
			await tryPeers((peerID, networkID) => api.lishnets.addPeerLish(row.id, peerID, networkID));
			addNotification($t('network.lishAdded', { name: row.name || row.id }), 'success');
		} catch (e: any) {
			addNotification(translateError(e), 'error');
		} finally {
			adding = false;
		}
	}

	async function handleShowDetail(): Promise<void> {
		// Closing an already-loaded detail is a pure UI toggle — allow it even while Add runs.
		if (detail) {
			detail = null;
			return;
		}
		if (busy || row.peers.length === 0) return;
		loadingDetail = true;
		try {
			detail = await tryPeers(async (peerID, networkID) => {
				const d = await api.lishnets.getPeerLish(row.id, peerID, networkID);
				// A null answer means this peer had nothing for us — flag it so the next peer is tried.
				if (!d) throw Object.assign(new Error($t('network.peerDeclined')), { tryNextPeer: true });
				return d;
			});
		} catch (e: any) {
			addNotification(translateError(e), 'error');
		} finally {
			loadingDetail = false;
		}
	}

	// y=0 — top bar (Back, Add to sharing, Details)
	// y=1 — title block (no nav items)
	// y=2+i — peer rows
	createNavArea(() => ({
		areaID,
		position,
		onBack,
		activate: true,
		listRange: (): [number, number] => [2, Math.max(2, 2 + row.peers.length)],
	}));
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
		align-items: center;
		gap: 2vh;
		width: 1200px;
		max-width: calc(94vw);
		padding: 2vh;
		border-radius: 2vh;
		box-sizing: border-box;
		background-color: var(--secondary-background);
		box-shadow: 0 0 2vh var(--secondary-background);
	}

	.lish-info {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		width: 100%;
		padding: 2vh;
		border-radius: 2vh;
		border: 0.4vh solid var(--secondary-softer-background);
		background-color: var(--secondary-soft-background);
		box-sizing: border-box;
		color: var(--secondary-foreground);
	}

	.lish-info .label {
		color: var(--disabled-foreground);
		font-size: 1.8vh;
	}

	.lish-info .value {
		font-size: 1.8vh;
		word-break: break-all;
	}

	.lish-info .value-mono {
		font-family: var(--font-mono);
	}

	.peer-status {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 0.8vh;
		font-size: 1.8vh;
		white-space: nowrap;
	}

	.peer-progress {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 0.4vh;
		width: 100%;
	}

	.peer-progress .peer-status {
		justify-content: center;
	}
	.peer-bytes {
		text-align: center;
		font-size: 1.5vh;
		white-space: nowrap;
		opacity: 0.8;
	}

	.button-bar-wrap {
		width: 100%;
	}

	.peer-id {
		font-family: var(--font-mono);
		font-size: 1.8vh;
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@media (max-width: 1199px) {
		.container {
			max-width: calc(100vw);
			margin: 0;
			border-radius: 0;
			box-shadow: none;
		}
	}
</style>

<div class="page">
	<div class="container">
		<div class="button-bar-wrap">
			<ButtonBar basePosition={[0, 0]}>
				<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} width="auto" />
				<Button icon="/img/download.svg" label={$t('network.addToDownloads')} onConfirm={handleAddToSharing} width="auto" disabled={busy || row.peers.length === 0} />
				<Button icon="/img/info.svg" label={$t('network.details')} onConfirm={handleShowDetail} width="auto" disabled={detail ? loadingDetail : busy || row.peers.length === 0} />
			</ButtonBar>
		</div>
		{#if detail}
			<NetworkLishDetailView {detail} />
		{:else}
			<div class="lish-info">
				<div><span class="label">{$t('common.name')}:</span> <span class="value">{row.name ?? $t('network.unnamed')}</span></div>
				<div><span class="label">{$t('network.lishID')}:</span> <span class="value value-mono">{row.id}</span></div>
			</div>
		{/if}

		<Table columns="auto 1fr 12vh 18vh">
			<TableHeader>
				<TableCell desktopOnly>#</TableCell>
				<TableCell>{$t('network.peerID')}</TableCell>
				<TableCell align="center">{$t('network.network')}</TableCell>
				<TableCell align="center">{$t('common.status')}</TableCell>
			</TableHeader>
			{#each row.peers as p, i}
				<TableRow position={[0, 2 + i]} onConfirm={makeOpenHandler(p.peerID, p.networkID)}>
					<TableCell desktopOnly>{i + 1}</TableCell>
					<TableCell><span class="peer-id">{p.peerID}</span></TableCell>
					<TableCell align="center">{networkName(p.networkID)}</TableCell>
					<TableCell align="center">
						{#if peerStatuses[i] === 'downloading'}
							{@const transfer = peerTransfer[i]}
							<div class="peer-progress">
								<span class="peer-status">{$t(isTransferred(transfer) ? 'network.statusProcessing' : 'network.statusDownloading')}</span>
								<ProgressBar progress={transferPercent(transfer)} showText={false} height="1.2vh" animated />
								{#if transfer && transfer.total > 0}
									<span class="peer-bytes">{formatSize(transfer.received)} / {formatSize(transfer.total)}</span>
								{/if}
							</div>
						{:else if peerStatuses[i] === 'downloaded'}
							<span class="peer-status"><Icon img="/img/check.svg" size="2vh" padding="0" colorVariable="--color-success" />{$t('network.statusDownloaded')}</span>
						{:else if peerStatuses[i] === 'unavailable'}
							<span class="peer-status"><Icon img="/img/cross.svg" size="2vh" padding="0" colorVariable="--color-error" />{$t('network.statusUnavailable')}</span>
						{/if}
					</TableCell>
				</TableRow>
			{/each}
		</Table>
	</div>
</div>
