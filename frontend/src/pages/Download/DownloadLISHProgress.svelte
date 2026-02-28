<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { scrollToElement } from '../../scripts/utils.ts';
	import { api } from '../../scripts/api.ts';
	import Alert from '../../components/Alert/Alert.svelte';
	import ProgressBar from '../../components/ProgressBar/ProgressBar.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Table from '../../components/Table/Table.svelte';
	import TableHeader from '../../components/Table/TableHeader.svelte';
	import TableRow from '../../components/Table/TableRow.svelte';
	import TableCell from '../../components/Table/TableCell.svelte';

	interface FileProgress {
		path: string;
		size: number;
		chunks: number;
		currentChunk: number;
		done: boolean;
	}

	interface ProgressEvent {
		type: 'file-list' | 'file-start' | 'chunk' | 'file';
		path?: string;
		current?: number;
		total?: number;
		size?: number;
		chunks?: number;
		files?: { path: string; size: number; chunks: number }[];
	}

	interface Props {
		areaID: string;
		position?: Position;
		params: Record<string, any>;
		onBack?: () => void;
		onDone?: (lishID: string) => void;
	}
	let { areaID, position = CONTENT_POSITIONS.main, params, onBack, onDone }: Props = $props();

	let active = $derived($activeArea === areaID);

	// Progress state
	type Status = 'creating' | 'done' | 'error';
	let status = $state<Status>('creating');
	let resultLishID = $state('');
	let errorText = $state('');

	// File list with per-file progress
	let allFiles = $state<FileProgress[]>([]);
	let completedCount = $derived(allFiles.filter(f => f.done).length);

	// Navigation: 0 = button, 1+ = table rows
	let selectedIndex = $state(0);
	let rowElements: HTMLElement[] = $state([]);
	let tableRowElements: HTMLElement[] = $state([]);
	let selectedTableRow = $derived(selectedIndex - 1); // -1 means button is selected

	function scrollToSelected(): void {
		if (selectedIndex === 0) scrollToElement(rowElements, 0, true);
		else scrollToElement(tableRowElements, selectedIndex - 1);
	}

	// Unsubscribe function for progress events
	let unsubProgress: (() => void) | null = null;

	function formatBytes(bytes: number, decimals: number = 2): string {
		if (bytes === 0) return '0 B';
		const k = 1024;
		const dm = decimals < 0 ? 0 : decimals;
		const sizes = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
	}

	function handleProgressEvent(data: ProgressEvent): void {
		if (data.type === 'file-list') {
			allFiles = (data.files || []).map(f => ({
				path: f.path,
				size: f.size,
				chunks: f.chunks,
				currentChunk: 0,
				done: false,
			}));
		} else if (data.type === 'chunk') {
			const path = data.path || '';
			const idx = allFiles.findIndex(f => f.path === path);
			if (idx >= 0) {
				allFiles[idx].currentChunk = data.current || 0;
			}
		} else if (data.type === 'file') {
			const path = data.path || '';
			const idx = allFiles.findIndex(f => f.path === path);
			if (idx >= 0) {
				allFiles[idx].done = true;
				allFiles[idx].currentChunk = allFiles[idx].chunks;
			}
		}
	}

	async function startCreate(): Promise<void> {
		status = 'creating';
		errorText = '';
		allFiles = [];

		// Subscribe to progress events (both local listener and server subscription)
		unsubProgress = api.on('lishs.create:progress', handleProgressEvent) || null;
		await api.subscribe('lishs.create:progress');

		try {
			const result = await api.lishs.create(params.dataPath, params.lishFile, params.addToSharing, params.name, params.description, params.algorithm, params.chunkSize, params.threads, params.minifyJson, params.compressGzip);
			resultLishID = result.lishID;
			status = 'done';
		} catch (err: any) {
			errorText = err?.message || String(err);
			status = 'error';
		} finally {
			await api.unsubscribe('lishs.create:progress').catch(() => {});
			if (unsubProgress) {
				unsubProgress();
				unsubProgress = null;
			}
		}
	}

	function handleBack(): void {
		onBack?.();
	}

	function handleDone(): void {
		if (onDone) onDone(resultLishID);
		else onBack?.();
	}

	// Area handlers
	const areaHandlers = {
		up() {
			if (selectedIndex > 0) {
				selectedIndex--;
				scrollToSelected();
				return true;
			}
			return false;
		},
		down() {
			if (allFiles.length > 0 && selectedIndex < allFiles.length) {
				selectedIndex++;
				scrollToSelected();
				return true;
			}
			return false;
		},
		left() {
			return false;
		},
		right() {
			return false;
		},
		confirmDown() {},
		confirmUp() {
			if (selectedIndex === 0) {
				if (status === 'creating') handleBack();
				else if (status === 'done') handleDone();
				else if (status === 'error') handleBack();
			}
		},
		confirmCancel() {},
		back() {
			handleBack();
		},
		onActivate() {},
	};

	let unregisterArea: (() => void) | null = null;

	onMount(() => {
		unregisterArea = useArea(areaID, areaHandlers, position);
		activateArea(areaID);
		startCreate();
	});

	onDestroy(() => {
		if (unregisterArea) unregisterArea();
		if (unsubProgress) {
			unsubProgress();
			unsubProgress = null;
		}
	});
</script>

<style>
	.progress-page {
		display: flex;
		flex-direction: column;
		align-items: center;
		height: 100%;
		padding: 2vh;
		gap: 2vh;
		overflow-y: auto;
	}

	.container {
		display: flex;
		flex-direction: column;
		gap: 1.5vh;
		width: 1000px;
		max-width: 100%;
	}

	.status-label {
		font-size: 2.5vh;
		color: var(--primary-foreground);
		font-weight: bold;
	}

	.done-info {
		font-size: 2vh;
		color: var(--secondary-foreground);
	}

	.done-info .lish-id {
		color: var(--primary-foreground);
		font-family: monospace;
		word-break: break-all;
	}
</style>

<div class="progress-page">
	<div class="container">
		<ButtonBar>
			<div bind:this={rowElements[0]}>
				<Button icon="/img/back.svg" label={status === 'creating' ? $t('common.cancel') : $t('common.back')} selected={active && selectedIndex === 0} onConfirm={status === 'done' ? handleDone : handleBack} />
			</div>
		</ButtonBar>
		{#if status === 'creating'}
			<div class="status-label">{$t('downloads.lishCreate.progress.creating')}</div>
		{:else if status === 'done'}
			<Alert type="info" message={$t('downloads.lishCreate.progress.done')} />
			<div class="done-info">
				<div>LISH ID: <span class="lish-id">{resultLishID}</span></div>
				<div>{$t('downloads.lishCreate.progress.filesProcessed')}: {allFiles.length}</div>
			</div>
		{:else if status === 'error'}
			<Alert type="error" message={errorText} />
		{/if}
		{#if allFiles.length > 0}
			<Table columns="1fr 10vh 14vh" columnsMobile="1fr 10vh 14vh">
				<TableHeader>
					<TableCell>{$t('common.fileName')}</TableCell>
					<TableCell align="right">{$t('common.size')}</TableCell>
					<TableCell align="center">{$t('common.progress')}</TableCell>
				</TableHeader>
				{#each allFiles as file, i}
					<div bind:this={tableRowElements[i]}>
						<TableRow odd={i % 2 === 0} selected={active && selectedTableRow === i}>
							<TableCell wrap>{file.path}</TableCell>
							<TableCell align="right">{formatBytes(file.size)}</TableCell>
							<TableCell align="center">
								<ProgressBar progress={file.chunks > 0 ? (file.currentChunk / file.chunks) * 100 : file.done ? 100 : 0} height="3vh" animated={status === 'creating' && !file.done && file.currentChunk > 0} />
							</TableCell>
						</TableRow>
					</div>
				{/each}
			</Table>
			{#if status === 'creating'}
				<div class="done-info">
					{$t('downloads.lishCreate.progress.filesProcessed')}: {completedCount} / {allFiles.length}
				</div>
			{/if}
		{/if}
	</div>
</div>
