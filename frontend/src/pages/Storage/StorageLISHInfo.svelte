<script lang="ts">
	import { onMount } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { createSubPage } from '../../scripts/subPage.svelte.ts';
	import { formatSize } from '../../scripts/utils.ts';
	import { type ILISHFileInspection } from '@shared';
	import { api } from '../../scripts/api.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import Icon from '../../components/Icon/Icon.svelte';
	import Table from '../../components/Table/Table.svelte';
	import TableHeader from '../../components/Table/TableHeader.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';
	import NetworkLishDetailView from '../Network/NetworkLishDetailView.svelte';
	import StorageLISHInfoItem from './StorageLISHInfoItem.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		/** The .lish / .lishs file opened in the file browser. */
		filePath: string;
		onBack?: (() => void) | undefined;
		/** Continue to the import dialog for the same file. */
		onImport: () => void;
	}
	let { areaID, position = LAYOUT.content, filePath, onBack, onImport }: Props = $props();
	let items = $state<ILISHFileInspection[]>([]);
	let loading = $state(true);
	let error = $state('');
	// Manifest of a .lishs opened from the table.
	let selected = $state<number | null>(null);
	// The import refuses a file with any invalid manifest, after importing the ones before it.
	let importable = $derived(items.length > 0 && items.every(item => !item.error));

	function itemError(item: ILISHFileInspection): string {
		return translateError(Object.assign(new Error(item.error ?? ''), { code: item.error, detail: item.errorDetail }));
	}

	async function load(): Promise<void> {
		loading = true;
		error = '';
		try {
			items = await api.lishs.inspectFile(filePath);
		} catch (e: any) {
			error = translateError(e);
			items = [];
		}
		loading = false;
	}

	function openItem(index: number): void {
		const detail = items[index]?.detail;
		selected = index;
		itemSubPage.enter(detail?.name || detail?.id.slice(0, 16) || '#' + (index + 1));
	}

	async function closeItem(): Promise<void> {
		selected = null;
		await itemSubPage.exit();
	}

	// y=0 — Back, Import; y=1+i — one row per manifest of a .lishs, or the file tree of a single one.
	// Everything below the buttons is one list, so the range is left open at the bottom.
	const navHandle = createNavArea(() => ({
		areaID,
		position,
		onBack,
		activate: true,
		listRange: (): [number, number] => [1, Number.MAX_SAFE_INTEGER],
	}));
	const itemSubPage = createSubPage(navHandle, () => areaID);

	onMount(() => {
		load();
	});
</script>

<style>
	.lish-info {
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

	.name {
		font-size: 1.8vh;
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.status {
		display: flex;
		justify-content: center;
		align-items: center;
		gap: 0.8vh;
		font-size: 1.8vh;
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

{#if itemSubPage.active && selected !== null && items[selected]}
	<StorageLISHInfoItem {areaID} {position} item={items[selected]!} error={items[selected]!.error ? itemError(items[selected]!) : ''} onBack={() => void closeItem()} />
{:else}
	<div class="lish-info">
		<div class="container">
			<ButtonBar basePosition={[0, 0]}>
				<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={onBack} width="auto" />
				{#if importable}
					<Button icon="/img/download.svg" label={$t('common.import')} onConfirm={onImport} width="auto" />
				{/if}
			</ButtonBar>
			{#if loading}
				<Spinner size="8vh" />
			{:else if error}
				<Alert type="error" message={error} />
			{:else if items.length === 0}
				<Alert type="warning" message={$t('lish.fileEmpty')} />
			{:else if items.length === 1}
				{#if items[0]!.error}
					<Alert type="error" message={itemError(items[0]!)} />
				{/if}
				{#if items[0]!.detail}
					<NetworkLishDetailView detail={items[0]!.detail} fileRowsBaseY={1} />
				{/if}
			{:else}
				<Table columns="auto 1fr 14vh 10vh 16vh" columnsMobile="1fr 14vh 10vh 16vh">
					<TableHeader>
						<TableCell desktopOnly>#</TableCell>
						<TableCell>{$t('common.name')}</TableCell>
						<TableCell align="center">{$t('common.size')}</TableCell>
						<TableCell align="center">{$t('common.files')}</TableCell>
						<TableCell align="center">{$t('common.status')}</TableCell>
					</TableHeader>
					{#each items as item, i (i)}
						<TableRow position={[0, 1 + i]} onConfirm={() => openItem(i)}>
							<TableCell desktopOnly>{i + 1}</TableCell>
							<TableCell><span class="name">{item.detail ? item.detail.name || item.detail.id : '—'}</span></TableCell>
							<TableCell align="center">{item.detail ? formatSize(item.detail.totalSize) : ''}</TableCell>
							<TableCell align="center">{item.detail ? item.detail.fileCount : ''}</TableCell>
							<TableCell align="center">
								{#if item.error}
									<span class="status"><Icon img="/img/cross.svg" size="2vh" padding="0" colorVariable="--color-error" />{$t('lish.fileInvalid')}</span>
								{:else}
									<span class="status"><Icon img="/img/check.svg" size="2vh" padding="0" colorVariable="--color-success" />{$t('lish.fileValid')}</span>
								{/if}
							</TableCell>
						</TableRow>
					{/each}
				</Table>
			{/if}
		</div>
	</div>
{/if}
