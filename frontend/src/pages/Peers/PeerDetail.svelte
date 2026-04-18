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
	import PeerDetailLishItem from './PeerDetailLishItem.svelte';
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

	.peer-info {
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

	.peer-info .label {
		color: var(--disabled-foreground);
		font-size: 1.8vh;
	}

	.peer-info .value {
		font-family: var(--font-mono);
		color: var(--secondary-foreground);
		font-size: 1.8vh;
		word-break: break-all;
	}

	.lishs {
		display: flex;
		flex-direction: column;
		gap: 2vh;
		width: 100%;
	}

	.button-bar-wrap {
		width: 100%;
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

{#if showLishDetail && selectedLish}
	<PeerDetailLish {areaID} {position} lish={selectedLish} peerID={peer.peerID} {networkID} onBack={handleLishDetailBack} />
{:else}
	<div class="peer-detail">
		<div class="container">
			<div class="button-bar-wrap">
				<ButtonBar>
					<Button icon="/img/back.svg" label={$t('common.back')} position={[0, 0]} onConfirm={onBack} width="auto" />
					<Button icon="/img/restart.svg" label={$t('common.refresh')} position={[1, 0]} onConfirm={loadLishs} width="auto" />
				</ButtonBar>
			</div>
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
				<div class="lishs">
					{#each lishs as lish, i (lish.id)}
						<PeerDetailLishItem name={lish.name || $t('peers.unnamed')} id={lish.id} totalSize={lish.totalSize} rowY={i + 1} disabled={addingLish === lish.id} onAdd={() => addToDownloads(lish)} onDetails={() => openLishDetail(lish)} />
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/if}
