<script lang="ts">
	import { onMount } from 'svelte';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { t } from '../../scripts/language.ts';
	import { formatSize, parseTags } from '../../scripts/catalog.ts';
	import { api } from '../../scripts/api.ts';
	import Icon from '../../components/Icon/Icon.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Row from '../../components/Row/Row.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	interface Props {
		areaID: string;
		position?: Position;
		category?: string;
		itemTitle?: string;
		itemId?: number | string;
		description?: string | null;
		totalSize?: number;
		fileCount?: number;
		tags?: string | null;
		contentType?: string | null;
		networkID?: string;
		lishID?: string;
		onBack?: () => void;
	}
	let { areaID, position = CONTENT_POSITIONS.main, itemTitle = 'Item', itemId = 1, description, totalSize, fileCount, tags, contentType, networkID, lishID, onBack }: Props = $props();
	let parsedTags = $derived(parseTags(tags ?? null));
	let sizeLabel = $derived(totalSize ? formatSize(totalSize) : null);
	let downloadStatus = $state<'idle' | 'starting' | 'downloading' | 'not_available' | 'error'>('idle');
	let downloadMessage = $state('');

	async function startDownload(): Promise<void> {
		if (!networkID || !lishID) { downloadMessage = 'Missing network or LISH ID'; downloadStatus = 'error'; return; }
		downloadStatus = 'starting';
		downloadMessage = '';
		try {
			const result = await api.catalog.startDownload(networkID, lishID);
			downloadStatus = result.status === 'downloading' ? 'downloading' : 'not_available';
			downloadMessage = result.message;
		} catch (e: any) {
			downloadMessage = e.message || 'Download failed';
			downloadStatus = 'error';
		}
	}

	function getContentIcon(): string {
		if (!contentType) return '/img/file.svg';
		if (contentType.startsWith('video/')) return '/img/play.svg';
		if (contentType.startsWith('audio/')) return '/img/play.svg';
		if (contentType.startsWith('image/')) return '/img/file.svg';
		if (contentType.includes('iso') || contentType.includes('disk')) return '/img/storage.svg';
		if (contentType.includes('msdownload') || contentType.includes('executable')) return '/img/settings.svg';
		return '/img/file.svg';
	}

	function getContentCategory(): string {
		if (!contentType) return 'File';
		if (contentType.startsWith('video/')) return 'Video';
		if (contentType.startsWith('audio/')) return 'Audio';
		if (contentType.startsWith('image/')) return 'Image';
		if (contentType.includes('iso')) return 'Disk Image';
		if (contentType.includes('msdownload')) return 'Software';
		return 'File';
	}

	const navHandle = createNavArea(() => ({ areaID, position, activate: true, onBack, initialPosition: [0, 0] }));

	onMount(() => {
		return navHandle.controller.register({
			pos: [0, 0],
			el: undefined,
		});
	});
</script>

<style>
	.detail {
		display: flex;
		flex-direction: column;
		align-items: center;
		overflow-y: auto;
		flex: 1;
		padding: 2vh;
	}

	.content {
		display: flex;
		flex-direction: column;
		gap: 2vh;
		width: 1200px;
		max-width: 100%;
	}

	.hero {
		width: 100%;
		aspect-ratio: 21 / 9;
		border-radius: 2vh;
		overflow: hidden;
		border: 0.4vh solid var(--secondary-softer-background);
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1vh;
		background-color: var(--secondary-soft-background);
	}

	.hero .icon-area {
		opacity: 0.4;
	}

	.hero .type-label {
		font-size: 2.5vh;
		color: var(--secondary-foreground);
		opacity: 0.3;
	}

	.info {
		display: flex;
		flex-direction: column;
		gap: 1.5vh;
	}

	.entry-title {
		font-size: 3vh;
		font-weight: bold;
		color: var(--primary-foreground);
	}

	.entry-description {
		font-size: 2vh;
		color: var(--secondary-foreground);
		opacity: 0.8;
		line-height: 1.6;
		white-space: pre-wrap;
	}

	.meta-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(20vh, 1fr));
		gap: 1vh;
	}

	.meta-card {
		display: flex;
		flex-direction: column;
		gap: 0.3vh;
		padding: 1.5vh;
		background-color: var(--secondary-soft-background);
		border-radius: 1vh;
	}

	.meta-card .meta-label {
		font-size: 1.4vh;
		color: var(--disabled-foreground);
		text-transform: uppercase;
		letter-spacing: 0.1vh;
	}

	.meta-card .meta-value {
		font-size: 2vh;
		font-weight: bold;
		color: var(--secondary-foreground);
	}

	.tags-row {
		display: flex;
		gap: 0.8vh;
		flex-wrap: wrap;
	}

	.tags-row .tag {
		font-size: 1.6vh;
		padding: 0.4vh 1vh;
		border-radius: 1vh;
		background-color: var(--primary-background);
		color: var(--primary-foreground);
	}

	.section-title {
		font-size: 2.5vh;
		font-weight: bold;
		color: var(--secondary-foreground);
		padding: 1vh 0;
	}

	.file-info {
		display: flex;
		flex-direction: column;
		gap: 0.5vh;
	}

	.file-name {
		font-size: 2vh;
		font-weight: bold;
		color: var(--secondary-foreground);
	}

	.file-size {
		font-size: 1.6vh;
		color: var(--disabled-foreground);
	}

	.file-actions {
		display: flex;
		gap: 2vh;
	}

	@media (max-width: 1199px) {
		.content {
			max-width: 100vw;
		}
	}
</style>

<div class="detail">
	<div class="content">
		<ButtonBar>
			<Button icon="/img/back.svg" label="Back" position={[0, 0]} onConfirm={onBack} width="auto" />
		</ButtonBar>

		<div class="hero">
			<div class="icon-area">
				<Icon img={getContentIcon()} size="10vh" />
			</div>
			<span class="type-label">{getContentCategory()}</span>
		</div>

		<div class="info">
			<div class="entry-title">{itemTitle}</div>
			{#if description}
				<div class="entry-description">{description}</div>
			{/if}
		</div>

		<div class="meta-grid">
			{#if sizeLabel}
				<div class="meta-card">
					<span class="meta-label">Size</span>
					<span class="meta-value">{sizeLabel}</span>
				</div>
			{/if}
			{#if fileCount}
				<div class="meta-card">
					<span class="meta-label">Files</span>
					<span class="meta-value">{fileCount}</span>
				</div>
			{/if}
			{#if contentType}
				<div class="meta-card">
					<span class="meta-label">Type</span>
					<span class="meta-value">{contentType}</span>
				</div>
			{/if}
			<div class="meta-card">
				<span class="meta-label">Category</span>
				<span class="meta-value">{getContentCategory()}</span>
			</div>
		</div>

		{#if parsedTags.length > 0}
			<div class="tags-row">
				{#each parsedTags as tag}
					<span class="tag">#{tag}</span>
				{/each}
			</div>
		{/if}

		{#if downloadStatus === 'error'}
			<Alert type="error" message={downloadMessage} />
		{:else if downloadStatus === 'downloading'}
			<Alert type="info" message={downloadMessage || 'Download started — check Downloads page for progress'} />
		{:else if downloadStatus === 'not_available'}
			<Alert type="warning" message={downloadMessage} />
		{/if}

		<div class="section-title">{$t('library.product.downloads')}:</div>
		<Row selected={navHandle.controller.isYSelected(1)}>
			<div class="file-info">
				<div class="file-name">{itemTitle}</div>
				<div class="file-size">{sizeLabel ?? 'Unknown size'} · {fileCount ?? 1} {(fileCount ?? 1) === 1 ? 'file' : 'files'}</div>
			</div>
			<div class="file-actions">
				<Button icon="/img/download.svg" label={downloadStatus === 'starting' ? '...' : $t('library.product.download')} position={[0, 1]} onConfirm={startDownload} disabled={downloadStatus === 'starting' || downloadStatus === 'downloading'} width="auto" />
				{#if contentType?.startsWith('video/') || contentType?.startsWith('audio/')}
					<Button icon="/img/play.svg" label={$t('library.product.play')} position={[1, 1]} width="auto" />
				{/if}
			</div>
		</Row>
	</div>
</div>
