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

	interface CreateParams {
		dataPath: string;
		lishFile?: string;
		addToSharing?: boolean;
		name?: string;
		description?: string;
		algorithm?: string;
		chunkSize?: number;
		threads?: number;
	}

	interface ProgressEvent {
		type: 'file-start' | 'chunk' | 'file';
		path?: string;
		current?: number;
		total?: number;
		size?: number;
		chunks?: number;
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

	// Current file progress
	let currentFile = $state('');
	let currentFileSize = $state(0);
	let currentChunk = $state(0);
	let totalChunks = $state(0);
	let fileProgress = $derived(totalChunks > 0 ? (currentChunk / totalChunks) * 100 : 0);

	// Log of completed files
	let completedFiles = $state<{ path: string; size: number }[]>([]);

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
		if (data.type === 'file-start') {
			currentFile = data.path || '';
			currentFileSize = data.size || 0;
			currentChunk = 0;
			totalChunks = data.chunks || 0;
		} else if (data.type === 'chunk') {
			currentChunk = data.current || 0;
			totalChunks = data.total || totalChunks;
		} else if (data.type === 'file') {
			completedFiles = [...completedFiles, { path: data.path || currentFile, size: currentFileSize }];
		}
	}

	async function startCreate(): Promise<void> {
		status = 'creating';
		errorText = '';
		completedFiles = [];
		currentFile = '';
		currentChunk = 0;
		totalChunks = 0;

		// Subscribe to progress events (both local listener and server subscription)
		unsubProgress = api.on('lishs.create:progress', handleProgressEvent) || null;
		await api.subscribe('lishs.create:progress');

		try {
			const result = await api.lishs.create(params.dataPath, params.lishFile, params.addToSharing, params.name, params.description, params.algorithm, params.chunkSize, params.threads);
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
		up: () => {
			if (selectedIndex > 0) {
				selectedIndex--;
				scrollToSelected();
				return true;
			}
			return false;
		},
		down: () => {
			if (completedFiles.length > 0 && selectedIndex < completedFiles.length) {
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
				if (status === 'creating') handleBack();
				else if (status === 'done') handleDone();
				else if (status === 'error') handleBack();
			}
		},
		confirmCancel: () => {},
		back: () => handleBack(),
		onActivate: () => {},
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

	.current-file {
		font-size: 2vh;
		color: var(--secondary-foreground);
		word-break: break-all;
	}

	.current-file .file-path {
		color: var(--primary-foreground);
	}

	.current-file .file-size {
		color: var(--disabled-foreground);
		margin-left: 1vh;
	}

	.chunk-info {
		font-size: 1.8vh;
		color: var(--disabled-foreground);
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
			{#if status === 'creating'}
				<div bind:this={rowElements[0]}>
					<Button icon="/img/back.svg" label={$t('common.cancel')} selected={active && selectedIndex === 0} onConfirm={handleBack} />
				</div>
			{:else if status === 'done'}
				<div bind:this={rowElements[0]}>
					<Button icon="/img/back.svg" label={$t('common.back')} selected={active && selectedIndex === 0} onConfirm={handleDone} />
				</div>
			{:else}
				<div bind:this={rowElements[0]}>
					<Button icon="/img/back.svg" label={$t('common.back')} selected={active && selectedIndex === 0} onConfirm={handleBack} />
				</div>
			{/if}
		</ButtonBar>

		{#if status === 'creating'}
			<div class="status-label">{$t('downloads.lishCreate.progress.creating')}</div>

			{#if currentFile}
				<div class="current-file">
					<span class="file-path">{currentFile}</span>
					{#if currentFileSize > 0}
						<span class="file-size">({formatBytes(currentFileSize)})</span>
					{/if}
				</div>

				<ProgressBar progress={fileProgress} animated />

				{#if totalChunks > 0}
					<div class="chunk-info">
						{$t('downloads.lishCreate.progress.chunks')}: {currentChunk} / {totalChunks}
					</div>
				{/if}
			{/if}

			{#if completedFiles.length > 0}
				<Table columns="1fr auto" columnsMobile="1fr auto">
					<TableHeader>
						<TableCell>{$t('common.fileName')}</TableCell>
						<TableCell>{$t('common.size')}</TableCell>
					</TableHeader>
					{#each completedFiles as file, i}
						<div bind:this={tableRowElements[i]}>
							<TableRow odd={i % 2 === 0} selected={active && selectedTableRow === i}>
								<TableCell wrap>✓ {file.path}</TableCell>
								<TableCell align="right">{formatBytes(file.size)}</TableCell>
							</TableRow>
						</div>
					{/each}
				</Table>
			{/if}
		{:else if status === 'done'}
			<Alert type="info" message={$t('downloads.lishCreate.progress.done')} />
			<div class="done-info">
				<div>LISH ID: <span class="lish-id">{resultLishID}</span></div>
				<div>{$t('downloads.lishCreate.progress.filesProcessed')}: {completedFiles.length}</div>
			</div>

			{#if completedFiles.length > 0}
				<Table columns="1fr auto" columnsMobile="1fr auto">
					<TableHeader>
						<TableCell>{$t('common.fileName')}</TableCell>
						<TableCell>{$t('common.size')}</TableCell>
					</TableHeader>
					{#each completedFiles as file, i}
						<div bind:this={tableRowElements[i]}>
							<TableRow odd={i % 2 === 0} selected={active && selectedTableRow === i}>
								<TableCell wrap>✓ {file.path}</TableCell>
								<TableCell align="right">{formatBytes(file.size)}</TableCell>
							</TableRow>
						</div>
					{/each}
				</Table>
			{/if}
		{:else if status === 'error'}
			<Alert type="error" message={errorText} />

			{#if completedFiles.length > 0}
				<Table columns="1fr auto" columnsMobile="1fr auto">
					<TableHeader>
						<TableCell>{$t('common.fileName')}</TableCell>
						<TableCell>{$t('common.size')}</TableCell>
					</TableHeader>
					{#each completedFiles as file, i}
						<div bind:this={tableRowElements[i]}>
							<TableRow odd={i % 2 === 0} selected={active && selectedTableRow === i}>
								<TableCell wrap>✓ {file.path}</TableCell>
								<TableCell align="right">{formatBytes(file.size)}</TableCell>
							</TableRow>
						</div>
					{/each}
				</Table>
			{/if}
		{/if}
	</div>
</div>
