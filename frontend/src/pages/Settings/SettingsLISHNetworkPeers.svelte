<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { type LISHNetworkConfig, type PeerConnectionInfo } from '@shared';
	import { api } from '../../scripts/api.ts';
	import { scrollToElement } from '../../scripts/utils.ts';
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
		position?: Position;
		network: LISHNetworkConfig;
		onBack?: () => void;
	}
	let { areaID, position = LAYOUT.content, network, onBack }: Props = $props();
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0);
	let peers = $state<PeerConnectionInfo[]>([]);
	let loading = $state(true);
	let error = $state('');
	let rowElements: HTMLElement[] = $state([]);

	// Items: Back button (0), peer rows (1 to peers.length)
	let totalItems = $derived(peers.length + 1);

	async function loadPeers() {
		loading = true;
		error = '';
		try {
			peers = await api.networks.getPeers(network.networkID);
		} catch (e: any) {
			error = e?.message || 'Failed to load peers';
			peers = [];
		}
		loading = false;
	}

	const scrollToSelected = () => scrollToElement(rowElements, selectedIndex);

	onMount(() => {
		let unregister: (() => void) | undefined;
		loadPeers().then(() => {
			unregister = useArea(
				areaID,
				{
					up: () => {
						if (selectedIndex > 0) {
							selectedIndex--;
							scrollToSelected();
							return true;
						}
						return false;
					},
					down: () => {
						if (selectedIndex < totalItems - 1) {
							selectedIndex++;
							scrollToSelected();
							return true;
						}
						return false;
					},
					left: () => false,
					right: () => false,
					confirmDown: () => {},
					confirmUp: () => {
						if (selectedIndex === 0) {
							onBack?.();
						} else {
							const peer = peers[selectedIndex - 1];
							console.log('Peer selected:', peer.peerId);
						}
					},
					confirmCancel: () => {},
					back: () => onBack?.(),
				},
				position
			);
			activateArea(areaID);
		});
		return () => {
			if (unregister) unregister();
		};
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
			<Button icon="/img/back.svg" label={$t('common.back')} selected={active && selectedIndex === 0} onConfirm={onBack} width="auto" />
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
					<div bind:this={rowElements[i + 1]}>
						<TableRow selected={active && selectedIndex === i + 1} odd={i % 2 !== 0}>
							<TableCell desktopOnly>{i + 1}</TableCell>
							<TableCell wrap><span class="peer-id">{peer.peerId}</span></TableCell>
							<TableCell>
								<div class="connections">
								{#if peer.direct > 0}<div>{$t('settings.lishNetwork.direct', { count: String(peer.direct) })}</div>{/if}
								{#if peer.relay > 0}<div>{$t('settings.lishNetwork.relayed', { count: String(peer.relay) })}</div>{/if}
								</div>
							</TableCell>
						</TableRow>
					</div>
				{/each}
			</Table>
		{/if}
	</div>
</div>
