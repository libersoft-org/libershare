<script lang="ts">
	import { onMount } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { pushBackHandler } from '../../scripts/focus.ts';
	import { activateArea } from '../../scripts/areas.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { type PeerListEntry, type PeerLishEntry } from '@shared';
	import { api } from '../../scripts/api.ts';
	import { tick } from 'svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import Table from '../../components/Table/Table.svelte';
	import TableHeader from '../../components/Table/TableHeader.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	import PeerDetailLish from './PeerDetailLish.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		peer: PeerListEntry;
		networkID: string;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, peer, networkID, onBack }: Props = $props();
	let lishs = $state<PeerLishEntry[] | null>(null);
	let loading = $state(true);
	let error = $state('');
	let addingLish = $state<string | null>(null);
	let removeBackHandler: (() => void) | null = null;
	// Detail view state
	let showLishDetail = $state(false);
	let selectedLish = $state<PeerLishEntry | null>(null);

	async function loadLishs(): Promise<void> {
		loading = true;
		error = '';
		try {
			const result = await api.lishnets.getPeerLishs(peer.peerID, networkID);
			lishs = result.lishs;
		} catch (e: any) {
			error = translateError(e);
			lishs = null;
		}
		loading = false;
	}

	async function addToDownloads(lish: PeerLishEntry): Promise<void> {
		addingLish = lish.id;
		try {
			await api.lishnets.addPeerLish(lish.id, peer.peerID, networkID);
			addNotification($t('peers.lishAdded', { name: lish.name || lish.id }), 'success');
		} catch (e: any) {
			addNotification(translateError(e), 'error');
		}
		addingLish = null;
	}

	function openLishDetail(lish: PeerLishEntry): void {
		selectedLish = lish;
		showLishDetail = true;
		navHandle.pause();
		pushBreadcrumb(lish.name || lish.id.slice(0, 16) + '...');
		removeBackHandler = pushBackHandler(handleLishDetailBack);
	}

	async function handleLishDetailBack(): Promise<void> {
		if (removeBackHandler) {
			removeBackHandler();
			removeBackHandler = null;
		}
		popBreadcrumb();
		showLishDetail = false;
		selectedLish = null;
		await tick();
		navHandle.resume();
		activateArea(areaID);
	}

	function getConnectionInfo(): string {
		const parts: string[] = [];
		if (peer.direct > 0) parts.push(`${peer.direct} direct`);
		if (peer.relay > 0) parts.push(`${peer.relay} relay`);
		return parts.join(', ');
	}

	const navHandle = createNavArea(() => ({ areaID, position, onBack, activate: true }));

	onMount(() => {
		loadLishs();
	});
</script>

<style>
	.peer-detail {
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

	.peer-info {
		display: flex;
		flex-direction: column;
		gap: 1vh;
		padding: 2vh;
		background-color: var(--secondary-soft-background);
		border: 0.2vh solid var(--secondary-softer-background);
		border-radius: 1vh;
	}

	.peer-info .label {
		color: var(--disabled-foreground);
		font-size: 1.8vh;
	}

	.peer-info .value {
		font-family: var(--font-mono);
		color: var(--primary-foreground);
		font-size: 1.8vh;
		word-break: break-all;
	}

	.lish-id {
		font-family: var(--font-mono);
		font-size: 1.6vh;
		color: var(--secondary-foreground);
		word-break: break-all;
	}

	.lish-name {
		font-size: 2vh;
		font-weight: bold;
		color: var(--primary-foreground);
	}

	.lish-row {
		display: flex;
		flex-direction: column;
		gap: 0.5vh;
	}

	.lish-actions {
		display: flex;
		gap: 1vh;
		margin-top: 0.5vh;
	}
</style>

{#if showLishDetail && selectedLish}
	<PeerDetailLish {areaID} {position} lish={selectedLish} peerID={peer.peerID} {networkID} onBack={handleLishDetailBack} />
{:else}
	<div class="peer-detail">
		<div class="container">
			<ButtonBar>
				<Button icon="/img/back.svg" label={$t('common.back')} position={[0, 0]} onConfirm={onBack} width="auto" />
				<Button icon="/img/restart.svg" label={$t('common.refresh')} position={[1, 0]} onConfirm={loadLishs} width="auto" />
			</ButtonBar>
			<div class="peer-info">
				<div><span class="label">{$t('peers.peerID')}:</span> <span class="value">{peer.peerID}</span></div>
				<div><span class="label">{$t('peers.network')}:</span> <span class="value">{peer.networks.map(n => n.networkName).join(', ')}</span></div>
				<div><span class="label">{$t('peers.connections')}:</span> <span class="value">{getConnectionInfo()}</span></div>
			</div>
			{#if loading}
				<Spinner size="8vh" />
			{:else if error}
				<Alert type="error" message={error} />
			{:else if lishs === null}
				<Alert type="warning" message={$t('peers.peerDeclined')} />
			{:else if lishs.length === 0}
				<Alert type="warning" message={$t('peers.noSharedLishs')} />
			{:else}
				<Table columns="1fr auto" columnsMobile="1fr auto">
					<TableHeader>
						<TableCell>{$t('peers.lish')}</TableCell>
						<TableCell>{$t('peers.actions')}</TableCell>
					</TableHeader>
					{#each lishs as lish, i}
						<TableRow position={[0, i + 1]}>
							<TableCell wrap>
								<div class="lish-row">
									<div class="lish-name">{lish.name || $t('peers.unnamed')}</div>
									<div class="lish-id">{lish.id}</div>
								</div>
							</TableCell>
							<TableCell>
								<div class="lish-actions">
									<Button icon="/img/download.svg" label={$t('peers.addToDownloads')} position={[0, i + 1]} onConfirm={() => addToDownloads(lish)} width="auto" disabled={addingLish === lish.id} />
									<Button icon="/img/info.svg" label={$t('peers.details')} position={[1, i + 1]} onConfirm={() => openLishDetail(lish)} width="auto" />
								</div>
							</TableCell>
						</TableRow>
					{/each}
				</Table>
			{/if}
		</div>
	</div>
{/if}
