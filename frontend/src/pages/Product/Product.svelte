<script lang="ts">
	import { onMount } from 'svelte';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { t } from '../../scripts/language.ts';
	import { formatSize, parseTags } from '../../scripts/catalog.ts';
	import ProductFile from './ProductFile.svelte';
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
		onBack?: () => void;
	}
	let { areaID, position = CONTENT_POSITIONS.main, itemTitle = 'Item', itemId = 1, description, totalSize, fileCount, tags, contentType, onBack }: Props = $props();
	let parsedTags = $derived(parseTags(tags ?? null));
	let sizeLabel = $derived(totalSize ? formatSize(totalSize) : null);
	let imageElement: HTMLElement;
	const navHandle = createNavArea(() => ({ areaID, position, activate: true, onBack, initialPosition: [0, 0] }));
	let imageSelected = $derived(navHandle.controller.isSelected([0, 0]));

	onMount(() => {
		return navHandle.controller.register({
			pos: [0, 0],
			get el() {
				return imageElement;
			},
		});
	});
</script>

<style>
	.detail {
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.detail .content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2vh;
		width: 1200px;
		max-width: calc(94vw);
		padding: 2vh;
		margin: 2vh;
		border-radius: 2vh;
		box-sizing: border-box;
		background-color: var(--secondary-background);
		box-shadow: 0 0 2vh var(--secondary-background);
	}

	.detail .content .header-area {
		width: 100%;
		aspect-ratio: 16 / 9;
		border-radius: 2vh;
		overflow: hidden;
		border: 0.4vh solid var(--secondary-softer-background);
		box-sizing: border-box;
		transition: all 0.2s linear;
		display: flex;
		align-items: center;
		justify-content: center;
		background-color: var(--secondary-soft-background);
	}

	.detail .content .header-area.selected {
		border-color: var(--primary-foreground);
	}

	.header-area .placeholder {
		font-size: 6vh;
		color: var(--secondary-foreground);
		opacity: 0.3;
	}

	.info {
		display: flex;
		flex-direction: column;
		gap: 1.5vh;
		width: 100%;
	}

	.info .entry-title {
		font-size: 3vh;
		font-weight: bold;
		color: var(--secondary-foreground);
	}

	.info .entry-description {
		font-size: 2vh;
		color: var(--secondary-foreground);
		opacity: 0.8;
		line-height: 1.5;
	}

	.info .meta-row {
		display: flex;
		gap: 2vh;
		flex-wrap: wrap;
		font-size: 1.8vh;
		color: var(--secondary-foreground);
		opacity: 0.7;
	}

	.meta-row .meta-item {
		padding: 0.5vh 1vh;
		background-color: var(--secondary-soft-background);
		border-radius: 1vh;
	}

	.info .tags-row {
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

	.detail .content .files {
		display: flex;
		flex-direction: column;
		gap: 2vh;
		width: 100%;
	}

	.detail .content .files .section-title {
		display: flex;
		align-items: center;
		font-size: 3vh;
		font-weight: bold;
		padding: 2vh;
		border-radius: 2vh;
		background-color: var(--secondary-soft-background);
		border: 0.4vh solid var(--secondary-softer-background);
		color: var(--secondary-foreground);
	}

	@media (max-width: 1199px) {
		.detail .content {
			max-width: calc(100vw);
			margin: 0;
			border-radius: 0;
			box-shadow: none;
		}
	}
</style>

<div class="detail">
	<div class="content">
		<div class="header-area" class:selected={imageSelected} bind:this={imageElement}>
			<span class="placeholder">{contentType ?? 'file'}</span>
		</div>
		<div class="info">
			<div class="entry-title">{itemTitle}</div>
			{#if description}
				<div class="entry-description">{description}</div>
			{/if}
			<div class="meta-row">
				{#if sizeLabel}<span class="meta-item">{sizeLabel}</span>{/if}
				{#if fileCount}<span class="meta-item">{fileCount} {fileCount === 1 ? 'file' : 'files'}</span>{/if}
				{#if contentType}<span class="meta-item">{contentType}</span>{/if}
			</div>
			{#if parsedTags.length > 0}
				<div class="tags-row">
					{#each parsedTags as tag}
						<span class="tag">#{tag}</span>
					{/each}
				</div>
			{/if}
		</div>
		<div class="files">
			<div class="section-title">{$t('library.product.downloads')}:</div>
			<ProductFile name={itemTitle} size={sizeLabel ?? 'Unknown'} rowY={1} />
		</div>
	</div>
</div>
