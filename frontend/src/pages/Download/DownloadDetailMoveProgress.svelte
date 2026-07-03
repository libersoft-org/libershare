<script lang="ts">
	import { onDestroy } from 'svelte';
	import { t, translateError } from '../../scripts/language.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { api } from '../../scripts/api.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
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
		bytesTransferred: number;
		done: boolean;
	}
	interface ProgressEvent {
		lishID: string;
		type: 'file-list' | 'chunk' | 'file';
		path?: string;
		totalFiles?: number;
		completedFiles?: number;
		totalBytes?: number;
		completedBytes?: number;
		fileBytes?: number;
		fileSize?: number;
		files?: { path: string; size: number }[];
	}
	interface Props {
		areaID: string;
		position?: Position;
		params: { lishID: string; newDirectory: string; moveData: boolean; createSubdirectory?: boolean };
		onBack?: () => void;
		onComplete?: () => void;
	}
	let { areaID, position = CONTENT_POSITIONS.main, params, onBack, onComplete }: Props = $props();
	type Status = 'moving' | 'done' | 'error';
	let status = $state<Status>('moving');
	let errorText = $state('');
	let overallProgress = $state(0);
	let totalBytes = $state(0);
	let completedBytes = $state(0);
	let allFiles = $state<FileProgress[]>([]);
	let completedCount = $derived(allFiles.filter(f => f.done).length);
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
		if (data.lishID !== params.lishID) return;
		if (data.type === 'file-list') {
			totalBytes = data.totalBytes ?? 0;
			completedBytes = 0;
			overallProgress = 0;
			allFiles = (data.files || []).map(f => ({
				path: f.path,
				size: f.size,
				bytesTransferred: 0,
				done: false,
			}));
		} else if (data.type === 'chunk') {
			completedBytes = data.completedBytes ?? 0;
			overallProgress = totalBytes > 0 ? Math.round((completedBytes / totalBytes) * 10000) / 100 : 0;
			const path = data.path || '';
			const idx = allFiles.findIndex(f => f.path === path);
			if (idx >= 0) allFiles[idx]!.bytesTransferred = data.fileBytes ?? 0;
		} else if (data.type === 'file') {
			completedBytes = data.completedBytes ?? 0;
			overallProgress = totalBytes > 0 ? Math.round((completedBytes / totalBytes) * 10000) / 100 : 0;
			const path = data.path || '';
			const idx = allFiles.findIndex(f => f.path === path);
			if (idx >= 0) {
				allFiles[idx]!.done = true;
				allFiles[idx]!.bytesTransferred = allFiles[idx]!.size;
			}
		}
	}

	async function startMove(): Promise<void> {
		status = 'moving';
		errorText = '';
		allFiles = [];
		unsubProgress = api.on('lishs:move:progress', handleProgressEvent) || null;
		await api.subscribe('lishs:move:progress');
		try {
			await api.lishs.move(params.lishID, params.newDirectory, params.moveData, params.createSubdirectory);
			status = 'done';
			onComplete?.();
		} catch (err: any) {
			errorText = translateError(err);
			status = 'error';
		} finally {
			if (unsubProgress) {
				unsubProgress();
				unsubProgress = null;
			}
		}
	}

	createNavArea(() => ({ areaID, position, activate: true, onBack: handleBack }));

	function handleBack(): void {
		onBack?.();
	}

	startMove();

	onDestroy(() => {
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
		box-sizing: border-box;
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
</style>

<div class="progress-page">
	<div class="container">
		<ButtonBar basePosition={[0, 0]}>
			<Button icon="/img/back.svg" label={$t('common.back')} onConfirm={handleBack} />
		</ButtonBar>
		{#if status === 'moving'}
			<div class="status-label">{$t('downloads.moveProgress.moving')}</div>
			<ProgressBar progress={overallProgress} height="3vh" animated />
			<div class="done-info">{formatBytes(completedBytes)} / {formatBytes(totalBytes)}</div>
		{:else if status === 'done'}
			<Alert type="info" message={$t('downloads.moveProgress.done')} />
			<div class="done-info">
				<div>{$t('downloads.moveProgress.filesMoved')}: {allFiles.length}</div>
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
					<TableRow position={[0, i + 1]}>
						<TableCell wrap>{file.path}</TableCell>
						<TableCell align="right">{formatBytes(file.size)}</TableCell>
						<TableCell align="center">
							<ProgressBar progress={file.size > 0 ? (file.bytesTransferred / file.size) * 100 : file.done ? 100 : 0} height="3vh" animated={status === 'moving' && !file.done && file.bytesTransferred > 0} />
						</TableCell>
					</TableRow>
				{/each}
			</Table>
			{#if status === 'moving'}
				<div class="done-info">
					{$t('downloads.moveProgress.filesMoved')}: {completedCount} / {allFiles.length}
				</div>
			{/if}
		{/if}
	</div>
</div>
