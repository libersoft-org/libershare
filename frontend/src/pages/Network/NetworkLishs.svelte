<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { type LishSearchResult } from '@shared';
	import { formatSize } from '../../scripts/utils.ts';
	import { type LishSearchSession } from '../../scripts/lishSearch.svelte.ts';
	import { networkSummary } from '../../scripts/networks.ts';
	import Alert from '../../components/Alert/Alert.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import Table from '../../components/Table/Table.svelte';
	import TableHeader from '../../components/Table/TableHeader.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	import Input from '../../components/Input/Input.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	interface Props {
		baseY: number; // Y-coordinate of the filter row in the parent NavArea grid. Result rows live at `baseY + 1 + i`
		search: LishSearchSession; // Search session created and disposed by the parent (so the parent can also read result count for its NavArea `listRange`).
		onOpenLishPeers: (row: LishSearchResult) => void;
	}
	let { baseY, search, onOpenLishPeers }: Props = $props();

	function handleStart(): void {
		void search.start();
	}

	function handleCancel(): void {
		void search.cancel();
	}

	function makeOpenHandler(row: LishSearchResult): () => void {
		return () => onOpenLishPeers(row);
	}
</script>

<style>
	.filters {
		display: flex;
		gap: 2vh;
		align-items: center;
		flex-wrap: wrap;
	}

	.lish-id {
		font-family: var(--font-mono);
		font-size: 1.4vh;
		color: var(--disabled-foreground);
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.lish-name {
		font-size: 1.8vh;
		font-weight: bold;
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.search-status {
		font-size: 1.6vh;
		color: var(--secondary-foreground);
		display: flex;
		align-items: center;
		gap: 1vh;
	}

	.search-status.stacked {
		flex-direction: column;
		gap: 2vh;
		padding: 4vh 0;
		font-size: 2vh;
	}
</style>

<div class="filters">
	<Input bind:value={search.query} placeholder={$t('network.searchLishsPlaceholder')} fontSize="2vh" padding="1vh 1.5vh" position={[0, baseY]} flex />
	<Button icon="/img/search.svg" label={$t('common.search')} onConfirm={handleStart} position={[1, baseY]} width="auto" disabled={search.searching || search.query.trim().length === 0} />
	{#if search.searching}
		<Button icon="/img/cross.svg" label={$t('common.cancel')} onConfirm={handleCancel} position={[2, baseY]} width="auto" />
	{/if}
</div>
{#if search.error}
	<Alert type="error" message={search.error} />
{:else}
	{#if search.searching}
		<!-- Same big spinner whether 0 or N results: keeps the visual centre of attention
		     stable while incremental results stream in below. Older code used a tiny inline
		     spinner once results arrived, which made the search look "done" prematurely. -->
		<div class="search-status stacked">
			<Spinner size="8vh" />
			<span>{$t('network.searching')}{#if search.results.length > 0} — {$t('network.lishCount', { count: String(search.results.length) })}{/if}</span>
		</div>
	{:else if search.results.length === 0 && search.searchID !== null}
		<Alert type="warning" message={$t('network.noResults')} />
		<!-- Diagnostic hint: most "search returned nothing" reports turn out to be a mesh
		     connectivity problem (0 peers) rather than a query mismatch. Surface peer/network
		     counts so the user can tell the difference without opening Settings. -->
		{#if $networkSummary.totalPeers === 0}
			<Alert type="info" message={$t('network.noResultsNoPeers')} />
		{:else}
			<Alert type="info" message={$t('network.noResultsDiagnostic', { peers: String($networkSummary.totalPeers), networks: String($networkSummary.connectedNetworks) })} />
		{/if}
	{:else if search.results.length > 0}
		<div class="search-status">
			<span>{$t('network.lishCount', { count: String(search.results.length) })}</span>
		</div>
	{/if}
	{#if search.results.length > 0}
		<Table columns="auto 2fr 1fr 12vh 10vh" columnsMobile="1fr auto">
			<TableHeader>
				<TableCell desktopOnly>#</TableCell>
				<TableCell>{$t('network.lishID')}</TableCell>
				<TableCell>{$t('common.name')}</TableCell>
				<TableCell align="center">{$t('network.totalSize')}</TableCell>
				<TableCell align="center">{$t('network.peerCount')}</TableCell>
			</TableHeader>
			{#each search.results as row, i (row.id)}
				<TableRow position={[0, baseY + 1 + i]} onConfirm={makeOpenHandler(row)}>
					<TableCell desktopOnly>{i + 1}</TableCell>
					<TableCell><span class="lish-id">{row.id}</span></TableCell>
					<TableCell><span class="lish-name">{row.name ?? $t('network.unnamed')}</span></TableCell>
					<TableCell align="center">{row.totalSize !== undefined ? formatSize(row.totalSize) : '—'}</TableCell>
					<TableCell align="center">{row.peers.length}</TableCell>
				</TableRow>
			{/each}
		</Table>
	{/if}
{/if}
