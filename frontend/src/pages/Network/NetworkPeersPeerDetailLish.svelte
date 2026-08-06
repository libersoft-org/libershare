<script lang="ts">
	import { onMount } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { addNotification } from '../../scripts/notifications.ts';
	import { copyToClipboard } from '../../scripts/clipboard.ts';
	import { type PeerLishEntry, type IPeerLishDetail } from '@shared';
	import { api } from '../../scripts/api.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import NetworkLishDetailView from './NetworkLishDetailView.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		lish: PeerLishEntry;
		peerID: string;
		networkID: string;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, lish, peerID, networkID, onBack }: Props = $props();
	let detail = $state<IPeerLishDetail | null>(null);
	let loading = $state(true);
	let error = $state('');
	let adding = $state(false);

	async function loadDetail(): Promise<void> {
		loading = true;
		error = '';
		try {
			detail = await api.lishnets.getPeerLish(lish.id, peerID, networkID);
		} catch (e: any) {
			error = translateError(e);
			detail = null;
		}
		loading = false;
	}

	async function addToDownloads(): Promise<void> {
		adding = true;
		try {
			await api.lishnets.addPeerLish(lish.id, peerID, networkID);
			addNotification($t('network.lishAdded', { name: lish.name || lish.id }), 'success');
		} catch (e: any) {
			addNotification(translateError(e), 'error');
		}
		adding = false;
	}

	async function copyLishID(): Promise<void> {
		await copyToClipboard(lish.id, $t('common.lishIDCopied'));
	}

	createNavArea(() => ({ areaID, position, onBack, activate: true }));

	onMount(() => {
		loadDetail();
	});
</script>

<style>
	.peer-lish-detail {
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
		align-items: stretch;
		gap: 2vh;
		width: 1200px;
		max-width: calc(94vw);
		padding: 2vh;
		border-radius: 2vh;
		box-sizing: border-box;
		background-color: var(--secondary-background);
		box-shadow: 0 0 2vh var(--secondary-background);
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

<div class="peer-lish-detail">
	<div class="container">
		<ButtonBar basePosition={[0, 0]}>
			<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} width="auto" />
			{#if detail}
				<Button icon="/img/download.svg" label={$t('network.addToDownloads')} onConfirm={addToDownloads} width="auto" disabled={adding} />
				<Button icon="/img/copy.svg" label={$t('common.copyLishID')} onConfirm={copyLishID} width="auto" />
			{/if}
		</ButtonBar>
		{#if loading}
			<Spinner size="8vh" />
		{:else if error}
			<Alert type="error" message={error} />
		{:else if detail}
			<NetworkLishDetailView {detail} fileRowsBaseY={1} />
		{/if}
	</div>
</div>
