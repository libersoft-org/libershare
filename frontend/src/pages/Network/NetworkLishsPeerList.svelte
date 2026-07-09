<script lang="ts">
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { formatSize, formatDate } from '../../scripts/utils.ts';
	import { api } from '../../scripts/api.ts';
	import { type LishSearchResult, type LISHNetworkConfig, type IPeerLishDetail } from '@shared';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import Table from '../../components/Table/Table.svelte';
	import TableHeader from '../../components/Table/TableHeader.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
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
	let detail = $state<IPeerLishDetail | null>(null);

	function networkName(networkID: string): string {
		return networks.find(n => n.networkID === networkID)?.name ?? networkID;
	}

	function makeOpenHandler(peerID: string, networkID: string): () => void {
		return () => onOpenPeer(peerID, networkID, row.id);
	}

	/**
	 * Try each peer offering this LISH in turn until one answers, returning its result.
	 * Realises the card's "take it from the first peer; if it times out, the next, and so on"
	 * fallback: `getPeerLish` / `addPeerLish` target a single peer, so the loop provides the
	 * resilience. Throws the last error only if every peer failed.
	 */
	async function withPeerFallback<T>(op: (peerID: string, networkID: string) => Promise<T>): Promise<T> {
		let lastErr: unknown = new Error('no peers');
		for (const p of row.peers) {
			try {
				return await op(p.peerID, p.networkID);
			} catch (e) {
				lastErr = e;
			}
		}
		throw lastErr;
	}

	async function handleAddToSharing(): Promise<void> {
		if (adding || row.peers.length === 0) return;
		adding = true;
		try {
			await withPeerFallback((peerID, networkID) => api.lishnets.addPeerLish(row.id, peerID, networkID));
			addNotification($t('network.lishAdded', { name: row.name || row.id }), 'success');
		} catch (e: any) {
			addNotification(translateError(e), 'error');
		}
		adding = false;
	}

	async function handleShowDetail(): Promise<void> {
		if (loadingDetail || row.peers.length === 0) return;
		if (detail) {
			detail = null;
			return;
		}
		loadingDetail = true;
		try {
			detail = await withPeerFallback(async (peerID, networkID) => {
				const d = await api.lishnets.getPeerLish(row.id, peerID, networkID);
				// A null answer means this peer had nothing for us — throw so the next peer is tried.
				if (!d) throw new Error($t('network.peerDeclined'));
				return d;
			});
		} catch (e: any) {
			addNotification(translateError(e), 'error');
		}
		loadingDetail = false;
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

	.detail-loading {
		display: flex;
		justify-content: center;
		padding: 1vh 0;
	}

	.detail-extra {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		margin-top: 1vh;
		padding-top: 1vh;
		border-top: 0.3vh solid var(--secondary-softer-background);
	}

	.file-list {
		display: flex;
		flex-direction: column;
		gap: 0.6vh;
		margin-top: 0.6vh;
		padding-top: 0.6vh;
		border-top: 0.2vh solid var(--secondary-softer-background);
	}

	.file-row {
		display: flex;
		justify-content: space-between;
		gap: 2vh;
	}

	.file-row .file-size {
		white-space: nowrap;
		color: var(--disabled-foreground);
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
				<Button icon="/img/download.svg" label={$t('network.addToDownloads')} onConfirm={handleAddToSharing} width="auto" disabled={adding || row.peers.length === 0} />
				<Button icon="/img/info.svg" label={$t('network.details')} onConfirm={handleShowDetail} width="auto" disabled={loadingDetail || row.peers.length === 0} />
			</ButtonBar>
		</div>
		<div class="lish-info">
			<div><span class="label">{$t('common.name')}:</span> <span class="value">{row.name ?? $t('network.unnamed')}</span></div>
			<div><span class="label">{$t('network.lishID')}:</span> <span class="value value-mono">{row.id}</span></div>
			{#if loadingDetail}
				<div class="detail-loading"><Spinner size="3vh" /></div>
			{:else if detail}
				<div class="detail-extra">
					{#if detail.description}
						<div><span class="label">{$t('common.description')}:</span> <span class="value">{detail.description}</span></div>
					{/if}
					<div><span class="label">{$t('network.created')}:</span> <span class="value">{formatDate(detail.created)}</span></div>
					<div><span class="label">{$t('network.totalSize')}:</span> <span class="value">{formatSize(detail.totalSize)}</span></div>
					<div><span class="label">{$t('network.chunkSize')}:</span> <span class="value">{formatSize(detail.chunkSize)}</span></div>
					<div><span class="label">{$t('network.checksumAlgo')}:</span> <span class="value">{detail.checksumAlgo}</span></div>
					<div><span class="label">{$t('common.files')}:</span> <span class="value">{detail.fileCount}</span></div>
					<div><span class="label">{$t('network.directories')}:</span> <span class="value">{detail.directoryCount}</span></div>
					{#if detail.files.length > 0}
						<div class="file-list">
							<div class="label">{$t('common.files')}:</div>
							{#each detail.files as f}
								<div class="file-row"><span class="value value-mono">{f.path}</span><span class="value file-size">{formatSize(f.size)}</span></div>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<Table columns="auto 1fr 12vh">
			<TableHeader>
				<TableCell desktopOnly>#</TableCell>
				<TableCell>{$t('network.peerID')}</TableCell>
				<TableCell align="center">{$t('network.network')}</TableCell>
			</TableHeader>
			{#each row.peers as p, i}
				<TableRow position={[0, 2 + i]} onConfirm={makeOpenHandler(p.peerID, p.networkID)}>
					<TableCell desktopOnly>{i + 1}</TableCell>
					<TableCell><span class="peer-id">{p.peerID}</span></TableCell>
					<TableCell align="center">{networkName(p.networkID)}</TableCell>
				</TableRow>
			{/each}
		</Table>
	</div>
</div>
