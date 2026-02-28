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
		position?: Position | undefined;
		network: LISHNetworkConfig;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = LAYOUT.content, network, onBack }: Props = $props();
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0);
	let buttonIndex = $state(0);
	let peers = $state<PeerConnectionInfo[]>([]);
	let loading = $state(true);
	let error = $state('');
	let rowElements: HTMLElement[] = $state([]);

	// Items: Back button (0), peer rows (1 to peers.length)
	let totalItems = $derived(peers.length + 1);

	async function loadPeers(): Promise<void> {
		loading = true;
		error = '';
		try {
			peers = await api.lishnets.getPeers(network.networkID);
		} catch (e: any) {
			error = e?.message || 'Failed to load peers';
			peers = [];
		}
		loading = false;
	}

	function scrollToSelected(): void {
		scrollToElement(rowElements, selectedIndex);
	}

	onMount(() => {
		let unregister: (() => void) | undefined;
		loadPeers().then(() => {
			unregister = useArea(
				areaID,
				{
					up() {
						if (selectedIndex > 0) {
							selectedIndex--;
							buttonIndex = 0;
							scrollToSelected();
							return true;
						}
						return false;
					},
					down() {
						if (selectedIndex < totalItems - 1) {
							selectedIndex++;
							buttonIndex = 0;
							scrollToSelected();
							return true;
						}
						return false;
					},
					left() {
						if (selectedIndex === 0 && buttonIndex > 0) {
							buttonIndex--;
							return true;
						}
						return false;
					},
					right() {
						if (selectedIndex === 0 && buttonIndex < 1) {
							buttonIndex++;
							return true;
						}
						return false;
					},
					confirmDown() {},
					confirmUp() {
						if (selectedIndex === 0) {
							if (buttonIndex === 0) onBack?.();
							else if (buttonIndex === 1) loadPeers();
							return;
						} else {
							const peer = peers[selectedIndex - 1]!;
							console.log('Peer selected:', peer.peerID);
						}
					},
					confirmCancel() {},
					back() { onBack?.(); },
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
			<Button icon="/img/back.svg" label={$t('common.back')} selected={active && selectedIndex === 0 && buttonIndex === 0} onConfirm={onBack} width="auto" />
			<Button icon="/img/restart.svg" label={$t('common.refresh')} selected={active && selectedIndex === 0 && buttonIndex === 1} onConfirm={loadPeers} width="auto" />
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
							<TableCell wrap><span class="peer-id">{peer.peerID}</span></TableCell>
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
