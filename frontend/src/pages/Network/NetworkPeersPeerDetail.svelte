<script lang="ts">
	import { onMount } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { createSubPage } from '../../scripts/subPage.svelte.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { type PeerListEntry, type PeerLishEntry } from '@shared';
	import { api } from '../../scripts/api.ts';
	import { tick } from 'svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import PeerDetailLishItem from './NetworkPeersPeerDetailLishItem.svelte';
	import PeerDetailLish from './NetworkPeersPeerDetailLish.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		peer: PeerListEntry;
		networkID: string;
		highlightLishID?: string | undefined;
		/** Publisher of the search row that led here (`null` = unsigned); undefined when not from search. */
		highlightPublisher?: string | null | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, peer, networkID, highlightLishID, highlightPublisher, onBack }: Props = $props();

	/** The search target is the (ID, publisher) pair, not the ID alone. */
	function isTarget(lish: PeerLishEntry): boolean {
		return lish.id === highlightLishID && (highlightPublisher === undefined || (lish.publisher ?? null) === highlightPublisher);
	}

	/**
	 * Publisher every manifest for this row must carry. The search target keeps the expectation the
	 * user picked it by, even when this peer now reports someone else; other rows use their own.
	 */
	function expectedPublisherFor(lish: PeerLishEntry): string | null {
		if (lish.id === highlightLishID && highlightPublisher !== undefined) return highlightPublisher;
		return lish.publisher ?? null;
	}

	let lishs = $state<PeerLishEntry[] | null>(null);
	let loading = $state(true);
	let error = $state('');
	let addingLish = $state<string | null>(null);
	// Per-row DOM refs so we can scroll the highlighted LISH into view once results load.
	let itemEls = $state<Record<string, HTMLDivElement | undefined>>({});
	// Detail view state
	let selectedLish = $state<PeerLishEntry | null>(null);
	// This peer lists the searched ID under a publisher other than the one the user picked.
	let targetPublisherDiffers = $derived(highlightPublisher !== undefined && !!lishs?.some(lish => lish.id === highlightLishID && !isTarget(lish)));

	async function loadLishs(): Promise<void> {
		loading = true;
		error = '';
		try {
			const result = await api.lishnets.getPeerLishs(peer.peerID, networkID);
			lishs = result.lishs;
			await tick();
			scrollToHighlight();
		} catch (e: any) {
			error = translateError(e);
			lishs = null;
		}
		loading = false;
	}

	// Scroll the row of `highlightLishID` (if set and present) into view. The visual ring
	// (PeerDetailLishItem `highlight` prop) tells the user which LISH was the search target.
	function scrollToHighlight(): void {
		if (!highlightLishID || !lishs?.some(isTarget)) return;
		const el = itemEls[highlightLishID];
		if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}

	async function addToDownloads(lish: PeerLishEntry): Promise<void> {
		addingLish = lish.id;
		try {
			await api.lishnets.addPeerLish(lish.id, peer.peerID, networkID, expectedPublisherFor(lish));
			addNotification($t('network.lishAdded', { name: lish.name || lish.id }), 'success');
		} catch (e: any) {
			addNotification(translateError(e), 'error');
		}
		addingLish = null;
	}

	function openLishDetail(lish: PeerLishEntry): void {
		selectedLish = lish;
		lishDetailSubPage.enter(lish.name || lish.id.slice(0, 16) + '...');
	}

	async function handleLishDetailBack(): Promise<void> {
		selectedLish = null;
		await lishDetailSubPage.exit();
	}

	function getConnectionInfo(): string {
		const parts: string[] = [];
		if (peer.direct > 0) parts.push(`${peer.direct} direct`);
		if (peer.relay > 0) parts.push(`${peer.relay} relay`);
		return parts.join(', ');
	}

	const navHandle = createNavArea(() => ({
		areaID,
		position,
		onBack,
		activate: true,
		listRange: (): [number, number] => [1, Math.max(1, lishs?.length ?? 0)],
	}));
	const lishDetailSubPage = createSubPage(navHandle, () => areaID);

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

{#if lishDetailSubPage.active && selectedLish}
	<PeerDetailLish {areaID} {position} lish={selectedLish} expectedPublisher={expectedPublisherFor(selectedLish)} peerID={peer.peerID} {networkID} onBack={() => void handleLishDetailBack()} />
{:else}
	<div class="peer-detail">
		<div class="container">
			<div class="button-bar-wrap">
				<ButtonBar basePosition={[0, 0]}>
					<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} width="auto" />
					<Button icon="/img/restart.svg" label={$t('common.refresh')} onConfirm={loadLishs} width="auto" />
				</ButtonBar>
			</div>
			<div class="peer-info">
				<div><span class="label">{$t('network.peerID')}:</span> <span class="value">{peer.peerID}</span></div>
				<div><span class="label">{$t('network.network')}:</span> <span class="value">{peer.networks.map(n => n.networkName).join(', ')}</span></div>
				<div><span class="label">{$t('network.connections')}:</span> <span class="value">{getConnectionInfo()}</span></div>
			</div>
			{#if loading}
				<Spinner size="8vh" />
			{:else if error}
				<Alert type="error" message={error} />
			{:else if lishs === null}
				<Alert type="warning" message={$t('network.peerDeclined')} />
			{:else if lishs.length === 0}
				<Alert type="warning" message={$t('network.noSharedLishs')} />
			{:else}
				{#if targetPublisherDiffers}
					<Alert type="warning" message={$t('lish.otherPublisherOnPeer')} />
				{/if}
				<div class="lishs">
					{#each lishs as lish, i (lish.id)}
						<PeerDetailLishItem bind:el={itemEls[lish.id]} name={lish.name || $t('network.unnamed')} id={lish.id} totalSize={lish.totalSize} publisher={lish.publisher} rowY={i + 1} disabled={addingLish === lish.id} highlight={isTarget(lish)} onAdd={() => addToDownloads(lish)} onDetails={() => openLishDetail(lish)} />
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/if}
