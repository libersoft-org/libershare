<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { type LISHNetworkConfig } from '@libershare/shared';
	import { api } from '../../scripts/api.ts';
	import { scrollToElement } from '../../scripts/utils.ts';
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
	let peers = $state<string[]>([]);
	let loading = $state(true);
	let error = $state('');
	let rowElements: HTMLElement[] = $state([]);

	// Items: peer rows (0 to peers.length - 1), Back button (last)
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
						if (selectedIndex < peers.length) {
							const peer = peers[selectedIndex];
							console.log('Peer selected:', peer);
						} else if (selectedIndex === totalItems - 1) {
							onBack?.();
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

	.title {
		font-size: 2.5vh;
		font-weight: bold;
		color: var(--secondary-foreground);
	}

	.back {
		margin-top: 2vh;
	}

	.peer-id {
		font-family: monospace;
		font-size: 1.8vh;
		word-break: break-all;
		white-space: normal;
	}
</style>

<div class="peer-list">
	<div class="container">
		<div class="title">{network.name} - {$t('settings.lishNetwork.peerList')}</div>
		{#if loading}
			<Spinner size="8vh" />
		{:else if error}
			<Alert type="error" message={error} />
		{:else if peers.length === 0}
			<Alert type="warning" message="No peers connected" />
		{:else}
			<Table columns="auto 1fr" columnsMobile="1fr">
				<TableHeader>
					<TableCell>#</TableCell>
					<TableCell>Peer ID</TableCell>
				</TableHeader>
				{#each peers as peer, i}
					<div bind:this={rowElements[i]}>
						<TableRow selected={active && selectedIndex === i} odd={i % 2 !== 0}>
							<TableCell>{i + 1}</TableCell>
							<TableCell><span class="peer-id">{peer}</span></TableCell>
						</TableRow>
					</div>
				{/each}
			</Table>
		{/if}
	</div>
	<div class="back" bind:this={rowElements[peers.length]}>
		<Button icon="/img/back.svg" label={$t('common.back')} selected={active && selectedIndex === totalItems - 1} onConfirm={onBack} />
	</div>
</div>
