<script lang="ts">
	import { onMount } from 'svelte';
	import { registerScene, activateScene } from '../../scripts/scenes.ts';
	import { focusArea, focusHeader, pushBackHandler } from '../../scripts/navigation.ts';
	import Breadcrumb from '../Breadcrumb/Breadcrumb.svelte';
	import ProductFile from './ProductFile.svelte';
	const SCENE_ID = 'product';
	interface Props {
		category?: string;
		itemTitle?: string;
		itemId?: number;
		onback?: () => void;
	}
	let { category = 'Movies', itemTitle = 'Item', itemId = 1, onback }: Props = $props();
	let active = $derived($focusArea === 'content');
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
				selectedRow = selectedRow <= -1 ? files.length - 1 : selectedRow - 1;
				break;
			case 'down':
				selectedRow = selectedRow >= files.length - 1 ? -1 : selectedRow + 1;
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
		window.scrollTo({ top: 0, behavior: 'instant' });
		const unregisterScene = registerScene(SCENE_ID, {
			up: () => {
				if (selectedRow === -1) {
					focusHeader();
				} else {
					navigate('up');
				}
			},
			down: () => navigate('down'),
			left: () => navigate('left'),
			right: () => navigate('right'),
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
			back: () => onback?.(),
		});
		activateScene(SCENE_ID);
		const unregisterBack = pushBackHandler(() => onback?.());
		return () => {
			unregisterScene();
			unregisterBack();
		};
	});
</script>

<style>
	.detail {
		display: flex;
		flex-direction: column;
		align-items: center;
		color: #fff;
	}

	.detail .content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1vw;
		width: 50vw;
		padding: 1vw;
		margin: 1vw;
		border-radius: 1vw;
		background-color: rgba(255, 255, 255, 0.05);
		box-shadow: 0 0px 2vw rgba(0, 0, 0, 0.5);
	}

	.detail .content .image {
		width: 100%;
		aspect-ratio: 16 / 9;
		border-radius: 1vw;
		overflow: hidden;
		border: 0.2vw solid rgba(255, 255, 255, 0.05);
		box-sizing: border-box;
		transition: all 0.2s linear;
	}

	.detail .content .image.selected {
		border-color: #aa0;
	}

	.detail .content .image img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.detail .content .files {
		display: flex;
		flex-direction: column;
		gap: 1vw;
		width: 100%;
	}

	.detail .content .files .title {
		display: flex;
		align-items: center;
		font-size: 1.5vw;
		font-weight: bold;
		padding: 1vw;
		border-radius: 1vw;
		background-color: #444;
	}
</style>

<div class="detail">
	<Breadcrumb items={[category, `${itemTitle}`]} />
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
