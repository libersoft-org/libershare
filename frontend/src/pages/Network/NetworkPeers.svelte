<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type PeerListEntry, type LISHNetworkConfig, type NetworkNodeInfo } from '@shared';
	import Alert from '../../components/Alert/Alert.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import Table from '../../components/Table/Table.svelte';
	import TableHeader from '../../components/Table/TableHeader.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	import Input from '../../components/Input/Input.svelte';
	import Select from '../../components/Input/Select.svelte';
	import SelectOption from '../../components/Input/SelectOption.svelte';
	import NodeInfoRow from '../../components/NodeInfo/NodeInfoRow.svelte';
	interface Props {
		peers: PeerListEntry[];
		filteredPeers: PeerListEntry[];
		networks: LISHNetworkConfig[];
		nodeInfo: NetworkNodeInfo | null;
		loading: boolean;
		error: string;
		/** Y-coordinate of the filter row. Peer rows live at `baseY + 1 + i`. */
		baseY: number;
		/** Y-coordinate of the NodeInfoRow toggle button (when nodeInfo is present). Address rows then occupy `nodeInfoRowY + 1 .. baseY - 1`. */
		nodeInfoRowY: number;
		/** Filter state owned by the parent (so parent can also derive filteredPeers + listRange). */
		peersSearch: string;
		selectedNetworkID: string;
		/** Whether the NodeInfo addresses sub-table is expanded (owned by parent for NavArea layout). */
		nodeInfoShowAddresses: boolean;
		onOpenPeer: (peer: PeerListEntry) => void;
	}
	let { peers, filteredPeers, networks, nodeInfo, loading, error, baseY, nodeInfoRowY, peersSearch = $bindable(), selectedNetworkID = $bindable(), nodeInfoShowAddresses = $bindable(), onOpenPeer }: Props = $props();

	function getNetworkNames(peer: PeerListEntry): string {
		return peer.networks.map(n => n.networkName).join(', ');
	}

	function makeOpenHandler(peer: PeerListEntry): () => void {
		return () => onOpenPeer(peer);
	}
</script>

<style>
	.filters {
		display: flex;
		gap: 2vh;
		align-items: center;
		flex-wrap: wrap;
	}

	.filters :global(.input-wrapper) {
		flex: 1;
		min-width: 24vh;
	}

	.peer-id {
		font-family: var(--font-mono);
		font-size: 1.8vh;
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.networks-col {
		font-size: 1.8vh;
		white-space: nowrap;
	}

	.connections {
		display: flex;
		flex-direction: column;
		line-height: 1.4;
		white-space: nowrap;
	}
</style>

{#if nodeInfo}
	<NodeInfoRow {nodeInfo} rowY={nodeInfoRowY} bind:showAddresses={nodeInfoShowAddresses} />
{/if}
{#if loading}
	<Spinner size="8vh" />
{:else if error}
	<Alert type="error" message={error} />
{:else if peers.length === 0}
	<Alert type="warning" message={$t('network.noPeers')} />
{:else}
	<div class="filters">
		<Input bind:value={peersSearch} placeholder={$t('network.searchPlaceholder')} fontSize="2vh" padding="1vh 1.5vh" position={[0, baseY]} />
		<Select bind:value={selectedNetworkID} fontSize="2vh" padding="1vh 1.5vh" position={[1, baseY]}>
			<SelectOption value="" label={$t('network.allNetworks')} />
			{#each networks as net}
				<SelectOption value={net.networkID} label={net.name} />
			{/each}
		</Select>
	</div>
	<Table columns="auto 1fr 30vh 15vh" columnsMobile="1fr auto">
		<TableHeader>
			<TableCell desktopOnly>#</TableCell>
			<TableCell>{$t('network.peerID')}</TableCell>
			<TableCell align="center">{$t('network.network')}</TableCell>
			<TableCell align="center">{$t('network.connections')}</TableCell>
		</TableHeader>
		{#each filteredPeers as peer, i}
			<TableRow position={[0, baseY + 1 + i]} onConfirm={makeOpenHandler(peer)}>
				<TableCell desktopOnly>{i + 1}</TableCell>
				<TableCell><span class="peer-id">{peer.peerID}</span></TableCell>
				<TableCell align="center"><span class="networks-col">{getNetworkNames(peer)}</span></TableCell>
				<TableCell align="center">
					<div class="connections">
						{#if peer.direct > 0}<div>{$t('network.direct', { count: String(peer.direct) })}</div>{/if}
						{#if peer.relay > 0}<div>{$t('network.relayed', { count: String(peer.relay) })}</div>{/if}
					</div>
				</TableCell>
			</TableRow>
		{/each}
	</Table>
{/if}
