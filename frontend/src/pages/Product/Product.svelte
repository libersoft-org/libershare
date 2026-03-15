<script lang="ts">
	import { onMount } from 'svelte';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import { t } from '../../scripts/language.ts';
	import ProductFile from './ProductFile.svelte';
	interface Props {
		areaID: string;
		position?: Position;
		category?: string;
		itemTitle?: string;
		itemId?: number | string;
		onBack?: () => void;
	}
	let { areaID, position = CONTENT_POSITIONS.main, itemTitle = 'Item', itemId = 1, onBack }: Props = $props();
	let files = $derived([
		{ id: 1, name: `${itemTitle} - 240p`, size: '218.32 MB' },
		{ id: 2, name: `${itemTitle} - 480p`, size: '780.12 MB' },
		{ id: 3, name: `${itemTitle} - 720p`, size: '2.72 GB' },
		{ id: 4, name: `${itemTitle} - 1080p`, size: '10.5 GB' },
		{ id: 5, name: `${itemTitle} - 2160p`, size: '26.81 GB' },
		{ id: 6, name: `${itemTitle} - 4320p`, size: '68.27 GB' },
	]);
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

	.detail .content .image {
		width: 100%;
		aspect-ratio: 16 / 9;
		border-radius: 2vh;
		overflow: hidden;
		border: 0.4vh solid var(--secondary-softer-background);
		box-sizing: border-box;
		transition: all 0.2s linear;
	}

	.detail .content .image.selected {
		border-color: var(--primary-foreground);
	}

	.detail .content .image img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.detail .content .files {
		display: flex;
		flex-direction: column;
		gap: 2vh;
		width: 100%;
	}

	.detail .content .files .title {
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
		<div class="image" class:selected={imageSelected} bind:this={imageElement}>
			<img src="https://picsum.photos/seed/{itemId}/800/450" alt={itemTitle} />
		</div>
		<div class="files">
			<div class="title">{$t('library.product.downloads')}:</div>
			{#each files as file, rowIndex (file.id)}
				<ProductFile name={file.name} size={file.size} rowY={rowIndex + 1} />
			{/each}
		</div>
	</div>
</div>
