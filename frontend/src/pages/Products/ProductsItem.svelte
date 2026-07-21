<script lang="ts">
	import { formatSize, parseTags } from '../../scripts/catalog.ts';
	interface Props {
		title?: string;
		totalSize?: number | undefined;
		fileCount?: number | undefined;
		tags?: string | null | undefined;
		contentType?: string | null | undefined;
		description?: string | null | undefined;
		isGamepadHovered?: boolean;
		isAPressed?: boolean;
		el?: HTMLElement | undefined;
	}
	let { title = '', totalSize, fileCount, tags, contentType, description, isGamepadHovered = false, isAPressed = false, el = $bindable() }: Props = $props();
	void el;
	let parsedTags = $derived(parseTags(tags ?? null));
	let sizeLabel = $derived(totalSize ? formatSize(totalSize) : '');
	let shortDesc = $derived(description ? (description.length > 80 ? description.slice(0, 80) + '...' : description) : '');
</script>

<style>
	.item {
		position: relative;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		background-color: var(--secondary-soft-background);
		border: 0.5vh solid var(--secondary-soft-background);
		border-radius: 2vh;
		overflow: hidden;
		aspect-ratio: 4 / 3;
		min-height: 20vh;
		box-sizing: border-box;
		transition: all 0.3s linear;
	}

	.item.hover {
		transform: scale(1.05);
		border-color: var(--primary-foreground);
	}

	.item.pressed {
		transform: scale(1);
	}

	.content {
		display: flex;
		flex-direction: column;
		gap: 0.5vh;
		padding: 1.2vh;
		background-color: var(--secondary-hard-background);
		opacity: 0.9;
	}

	.description {
		font-size: 1.3vh;
		color: var(--secondary-foreground);
		opacity: 0.5;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.title {
		color: var(--secondary-foreground);
		font-size: 2vh;
		font-weight: bold;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meta {
		display: flex;
		gap: 1vh;
		font-size: 1.4vh;
		color: var(--secondary-foreground);
		opacity: 0.7;
	}

	.tags {
		display: flex;
		gap: 0.5vh;
		flex-wrap: wrap;
	}

	.tag {
		font-size: 1.2vh;
		padding: 0.2vh 0.6vh;
		border-radius: 0.5vh;
		background-color: var(--primary-background);
		color: var(--primary-foreground);
		opacity: 0.8;
	}
</style>

<div bind:this={el} class="item" class:hover={isGamepadHovered} class:pressed={isAPressed}>
	<div class="content">
		<div class="title">{title}</div>
		{#if shortDesc}
			<div class="description">{shortDesc}</div>
		{/if}
		{#if sizeLabel || fileCount}
			<div class="meta">
				{#if sizeLabel}<span>{sizeLabel}</span>{/if}
				{#if fileCount}<span>{fileCount} {fileCount === 1 ? 'file' : 'files'}</span>{/if}
				{#if contentType}<span>{contentType}</span>{/if}
			</div>
		{/if}
		{#if parsedTags.length > 0}
			<div class="tags">
				{#each parsedTags.slice(0, 5) as tag}
					<span class="tag">#{tag}</span>
				{/each}
			</div>
		{/if}
	</div>
</div>
