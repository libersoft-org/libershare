<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { type LishSearchResult, type LISHNetworkConfig } from '@shared';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Table from '../../components/Table/Table.svelte';
	import TableHeader from '../../components/Table/TableHeader.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		row: LishSearchResult;
		networks: LISHNetworkConfig[];
		onBack: () => void;
		onOpenPeer: (peerID: string, networkID: string, lishID: string) => void;
	}
	let { areaID, position = LAYOUT.content, row, networks, onBack, onOpenPeer }: Props = $props();

	function networkName(networkID: string): string {
		return networks.find(n => n.networkID === networkID)?.name ?? networkID;
	}

	function makeOpenHandler(peerID: string, networkID: string): () => void {
		return () => onOpenPeer(peerID, networkID, row.id);
	}

	// y=0 — top bar (Back)
	// y=1 — title block (no nav items)
	// y=2+i — peer rows
	createNavArea(() => ({
		areaID,
		position,
		onBack,
		activate: true,
		listRange: () => [2, Math.max(2, 2 + row.peers.length)],
	}));
</script>

<style>
	.page {
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

	.lish-info {
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

	.lish-info .label {
		color: var(--disabled-foreground);
		font-size: 1.8vh;
	}

	.lish-info .value {
		font-size: 1.8vh;
		word-break: break-all;
	}

	.lish-info .value-mono {
		font-family: var(--font-mono);
	}

	.button-bar-wrap {
		width: 100%;
	}

	.peer-id {
		font-family: var(--font-mono);
		font-size: 1.8vh;
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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

<div class="page">
	<div class="container">
		<div class="button-bar-wrap">
			<ButtonBar basePosition={[0, 0]}>
				<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} width="auto" />
			</ButtonBar>
		</div>
		<div class="lish-info">
			<div><span class="label">{$t('common.name')}:</span> <span class="value">{row.name ?? $t('network.unnamed')}</span></div>
			<div><span class="label">{$t('network.lishID')}:</span> <span class="value value-mono">{row.id}</span></div>
		</div>

		<Table columns="auto 1fr 12vh">
			<TableHeader>
				<TableCell desktopOnly>#</TableCell>
				<TableCell>{$t('network.peerID')}</TableCell>
				<TableCell align="center">{$t('network.network')}</TableCell>
			</TableHeader>
			{#each row.peers as p, i}
				<TableRow position={[0, 2 + i]} onConfirm={makeOpenHandler(p.peerID, p.networkID)}>
					<TableCell desktopOnly>{i + 1}</TableCell>
					<TableCell><span class="peer-id">{p.peerID}</span></TableCell>
					<TableCell align="center">{networkName(p.networkID)}</TableCell>
				</TableRow>
			{/each}
		</Table>
	</div>
</div>
