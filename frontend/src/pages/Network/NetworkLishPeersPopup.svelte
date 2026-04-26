<script lang="ts">
	import { type LishSearchResult, type LISHNetworkConfig } from '@shared';
	import { t } from '../../scripts/language.ts';
	import Table from '../../components/Table/Table.svelte';
	import TableHeader from '../../components/Table/TableHeader.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	interface Props {
		row: LishSearchResult;
		networks: LISHNetworkConfig[];
		onClose: () => void;
		onOpenPeer: (peerID: string, networkID: string, lishID: string) => void;
	}
	let { row, networks, onClose, onOpenPeer }: Props = $props();

	function networkName(networkID: string): string {
		return networks.find(n => n.networkID === networkID)?.name ?? networkID;
	}

	function stopPropagation(e: Event): void {
		e.stopPropagation();
	}

	function handleBackdropKey(e: KeyboardEvent): void {
		if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onClose();
		}
	}

	function makeOpenHandler(peerID: string, networkID: string): () => void {
		return () => onOpenPeer(peerID, networkID, row.id);
	}
</script>

<style>
	.popup-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}

	.popup {
		background: var(--secondary-background);
		border-radius: 2vh;
		padding: 3vh;
		max-width: 900px;
		width: 90vw;
		max-height: 80vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 2vh;
	}

	.popup-title {
		font-size: 2.4vh;
		font-weight: bold;
	}

	.popup-subtitle {
		font-size: 1.6vh;
		color: var(--disabled-foreground);
		font-family: var(--font-mono);
		word-break: break-all;
	}

	.peer-id {
		font-family: var(--font-mono);
		font-size: 1.8vh;
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>

<div class="popup-backdrop" role="button" tabindex="-1" onclick={onClose} onkeydown={handleBackdropKey}>
	<div class="popup" role="dialog" aria-modal="true" tabindex="-1" onclick={stopPropagation} onkeydown={stopPropagation}>
		<div class="popup-title">{row.name ?? $t('network.unnamed')}</div>
		<div class="popup-subtitle">{row.id}</div>
		<div class="popup-title">{$t('network.peersWithLish')}</div>
		<Table columns="auto 1fr 12vh">
			<TableHeader>
				<TableCell desktopOnly>#</TableCell>
				<TableCell>{$t('network.peerID')}</TableCell>
				<TableCell align="center">{$t('network.network')}</TableCell>
			</TableHeader>
			{#each row.peers as p, i}
				<TableRow position={[0, 100 + i]} onConfirm={makeOpenHandler(p.peerID, p.networkID)}>
					<TableCell desktopOnly>{i + 1}</TableCell>
					<TableCell><span class="peer-id">{p.peerID}</span></TableCell>
					<TableCell align="center">{networkName(p.networkID)}</TableCell>
				</TableRow>
			{/each}
		</Table>
		<ButtonBar basePosition={[0, 200]}>
			<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onClose} width="auto" />
		</ButtonBar>
	</div>
</div>
