<script lang="ts">
	import { onMount } from 'svelte';
	import { registerArea, activateArea, activeArea, navigateUp, navigateLeft, navigateRight } from '../../scripts/areas.ts';
	import { pushBackHandler } from '../../scripts/navigation.ts';
	import ProductFile from './ProductFile.svelte';
	const AREA_ID = 'product';
	interface Props {
		category?: string;
		itemTitle?: string;
		itemId?: number;
		onBack?: () => void;
	}
	let { category = 'Movies', itemTitle = 'Item', itemId = 1, onBack }: Props = $props();
	let active = $derived($activeArea === AREA_ID);
	const files = [
		{ id: 1, name: `${itemTitle} - 240p.mp4`, size: '218.32 MB' },
		{ id: 2, name: `${itemTitle} - 480p.mp4`, size: '780.12 MB' },
		{ id: 3, name: `${itemTitle} - 720p.mp4`, size: '2.72 GB' },
		{ id: 4, name: `${itemTitle} - 1080p.mp4`, size: '10.5 GB' },
		{ id: 5, name: `${itemTitle} - 2160p.mp4`, size: '26.81 GB' },
		{ id: 6, name: `${itemTitle} - 4320p.mp4`, size: '68.27 GB' },
	];
	let selectedRow = $state(-1); // -1 = image, 0+ = files
	let selectedButton = $state(0); // 0 = Download, 1 = Play
	let isAPressed = $state(false);
	let fileElements: HTMLElement[] = $state([]);
	let imageElement: HTMLElement;

	function navigate(direction: string): void {
		switch (direction) {
			case 'up':
				if (selectedRow > -1) selectedRow--;
				break;
			case 'down':
				if (selectedRow < files.length - 1) selectedRow++;
				break;
			case 'left':
				if (selectedRow >= 0) selectedButton = 0;
				break;
			case 'right':
				if (selectedRow >= 0) selectedButton = 1;
				break;
		}
		scrollToSelected();
	}

	function scrollToSelected(): void {
		if (selectedRow === -1) {
			imageElement?.scrollIntoView({
				behavior: 'smooth',
				block: 'center',
			});
		} else {
			const selectedElement = fileElements[selectedRow];
			if (selectedElement) {
				selectedElement.scrollIntoView({
					behavior: 'smooth',
					block: 'center',
				});
			}
		}
	}

	function selectButton(): void {
		if (selectedRow === -1) return; // image selected, no	action
		const action = selectedButton === 0 ? 'download' : 'play';
	}

	onMount(() => {
		const unregisterArea = registerArea(AREA_ID, { x: 1, y: 1 }, {
			up: () => {
				if (selectedRow === -1) {
					navigateUp();
				} else {
					navigate('up');
				}
			},
			down: () => navigate('down'),
			left: () => {
				if (selectedRow === -1 || selectedButton === 0) navigateLeft();
				else navigate('left');
			},
			right: () => {
				if (selectedRow === -1 || selectedButton === 1) navigateRight();
				else navigate('right');
			},
			confirmDown: () => {
				isAPressed = true;
			},
			confirmUp: () => {
				isAPressed = false;
				selectButton();
			},
			confirmCancel: () => {
				isAPressed = false;
			},
			back: () => onBack?.(),
		});
		activateArea(AREA_ID);
		const unregisterBack = pushBackHandler(() => onBack?.());
		return () => {
			unregisterArea();
			unregisterBack();
		};
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
		<div class="image" class:selected={active && selectedRow === -1} bind:this={imageElement}>
			<img src="https://picsum.photos/seed/{itemId}/800/450" alt={itemTitle} />
		</div>
		<div class="files">
			<div class="title">Files</div>
			{#each files as file, rowIndex (file.id)}
				<div bind:this={fileElements[rowIndex]}>
					<ProductFile name={file.name} size={file.size} selected={active && rowIndex === selectedRow} {selectedButton} pressed={active && isAPressed} />
				</div>
			{/each}
		</div>
	</div>
</div>
