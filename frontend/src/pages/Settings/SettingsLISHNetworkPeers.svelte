<script lang="ts">
	import { onMount } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { type LISHNetworkConfig, type PeerConnectionInfo } from '@shared';
	import { api } from '../../scripts/api.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import Table from '../../components/Table/Table.svelte';
	import TableHeader from '../../components/Table/TableHeader.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		network: LISHNetworkConfig;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, network, onBack }: Props = $props();
	let peers = $state<PeerConnectionInfo[]>([]);
	let loading = $state(true);
	let error = $state('');

	async function loadPeers(): Promise<void> {
		loading = true;
		error = '';
		try {
			peers = await api.lishnets.getPeers(network.networkID);
		} catch (e: any) {
			error = translateError(e);
			peers = [];
		}
		loading = false;
	}

	createNavArea(() => ({ areaID, position, onBack, activate: true }));

	onMount(() => {
		loadPeers();
	});
</script>

<style>
	.peer-list {
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
		font-family: monospace;
		font-size: 1.8vh;
		word-break: break-all;
		white-space: normal;
	}

	.connections {
		display: flex;
		flex-direction: column;
		line-height: 1.4;
		white-space: nowrap;
	}
</style>

<div class="peer-list">
	<div class="container">
		<ButtonBar>
			<Button icon="/img/back.svg" label={$t('common.back')} position={[0, 0]} onConfirm={onBack} width="auto" />
			<Button icon="/img/restart.svg" label={$t('common.refresh')} position={[1, 0]} onConfirm={loadPeers} width="auto" />
		</ButtonBar>
		{#if loading}
			<Spinner size="8vh" />
		{:else if error}
			<Alert type="error" message={error} />
		{:else if peers.length === 0}
			<Alert type="warning" message={$t('settings.lishNetwork.noPeers')} />
		{:else}
			<Table columns="auto 1fr auto" columnsMobile="1fr auto">
				<TableHeader>
					<TableCell desktopOnly>#</TableCell>
					<TableCell>{$t('settings.lishNetwork.peerID')}</TableCell>
					<TableCell>{$t('settings.lishNetwork.connections')}</TableCell>
				</TableHeader>
				{#each peers as peer, i}
					<TableRow position={[0, i + 1]} odd={i % 2 !== 0} onConfirm={() => console.log('Peer selected:', peer.peerID)}>
						<TableCell desktopOnly>{i + 1}</TableCell>
						<TableCell wrap><span class="peer-id">{peer.peerID}</span></TableCell>
						<TableCell>
							<div class="connections">
								{#if peer.direct > 0}<div>{$t('settings.lishNetwork.direct', { count: String(peer.direct) })}</div>{/if}
								{#if peer.relay > 0}<div>{$t('settings.lishNetwork.relayed', { count: String(peer.relay) })}</div>{/if}
							</div>
						</TableCell>
					</TableRow>
				{/each}
			</Table>
		{/if}
	</div>
</div>
