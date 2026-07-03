<script lang="ts">
	import { getContext } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import type { NavAreaController } from '../../scripts/navArea.svelte.ts';
	import { type NetworkNodeInfo } from '@shared';
	import Row from '../Row/Row.svelte';
	import Button from '../Buttons/Button.svelte';
	import Table from '../Table/Table.svelte';
	import TableRow from '../Table/TableRow.svelte';
	import TableCell from '../Table/TableCell.svelte';
	interface Props {
		nodeInfo: NetworkNodeInfo;
		rowY: number;
		buttonX?: number;
		showAddresses?: boolean;
	}
	let { nodeInfo, rowY, buttonX = 0, showAddresses = $bindable(false) }: Props = $props();
	const navArea = getContext<NavAreaController | undefined>('navArea');
	let rowSelected = $derived(navArea ? navArea.isSelected([buttonX, rowY]) : false);

	function toggleAddresses(): void {
		showAddresses = !showAddresses;
	}
</script>

<style>
	.node-info {
		display: flex;
		flex-direction: column;
		gap: 1.5vh;
		width: 100%;
	}

	.node-info .peer-id {
		font-size: 1.8vh;
		word-break: break-all;
	}

	.node-info .peer-id .label {
		color: var(--disabled-foreground);
	}

	.node-info .peer-id .value {
		font-family: var(--font-mono);
		color: var(--primary-foreground);
	}

	.node-info .buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 1vh;
	}

	.node-info .address-index {
		font-size: 1.5vh;
		font-family: var(--font-mono);
		color: var(--disabled-foreground);
	}

	.node-info .address-value {
		font-size: 1.5vh;
		font-family: var(--font-mono);
		color: var(--disabled-foreground);
		word-break: break-all;
	}
</style>

{#if nodeInfo}
	<Row selected={rowSelected}>
		<div class="node-info">
			<div class="peer-id"><span class="label">{$t('settings.lishNetwork.yourPeerID')}:</span> <span class="value">{nodeInfo.peerID}</span></div>
			<div class="buttons">
				<Button icon={showAddresses ? '/img/up.svg' : '/img/down.svg'} label={showAddresses ? $t('common.hide') + ' ' + $t('settings.lishNetwork.addresses') : $t('common.show') + ' ' + $t('settings.lishNetwork.addresses')} position={[buttonX, rowY]} onConfirm={toggleAddresses} />
			</div>
			{#if showAddresses && nodeInfo.addresses.length > 0}
				<Table columns="auto 1fr">
					{#each nodeInfo.addresses as address, i}
						<TableRow position={[buttonX, rowY + 1 + i]}>
							<TableCell><span class="address-index">{i + 1}.</span></TableCell>
							<TableCell wrap><span class="address-value">{address}</span></TableCell>
						</TableRow>
					{/each}
				</Table>
			{/if}
		</div>
	</Row>
{/if}
