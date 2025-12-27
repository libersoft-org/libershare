<script lang="ts">
	import { onMount } from 'svelte';
	import { useInput } from '../scripts/input';
	import Breadcrumb from './Breadcrumb.svelte';
	import FileItem from './ItemDetailFile.svelte';

	interface Props {
		category?: string;
		itemTitle?: string;
		itemId?: number;
		onback?: () => void;
	}
	let { category = 'Movies', itemTitle = 'Item', itemId = 1, onback }: Props = $props();

	// Mock files data
	const files = [
		{ id: 1, name: `${itemTitle} - 1080p.mp4`, size: '10.5 GB' },
		{ id: 2, name: `${itemTitle} - 2160p.mp4`, size: '26.8 GB' },
	];

	let selectedRow = $state(0);
	let selectedButton = $state(0); // 0 = Download, 1 = Play
	let isAPressed = $state(false);

	function navigate(direction: string): void {
		switch (direction) {
			case 'up':
				selectedRow = Math.max(0, selectedRow - 1);
				break;
			case 'down':
				selectedRow = Math.min(files.length - 1, selectedRow + 1);
				break;
			case 'left':
				selectedButton = 0;
				break;
			case 'right':
				selectedButton = 1;
				break;
		}
	}

	function selectButton(): void {
		const action = selectedButton === 0 ? 'download' : 'play';
		console.log(`${action} file:`, files[selectedRow].name);
	}

	onMount(() => {
		return useInput('item-detail', {
			up: () => navigate('up'),
			down: () => navigate('down'),
			left: () => navigate('left'),
			right: () => navigate('right'),
			confirmDown: () => {
				isAPressed = true;
				selectButton();
			},
			confirmUp: () => {
				isAPressed = false;
			},
			back: () => onback?.(),
		});
	});
</script>

<style>
	.detail {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
		color: #fff;
	}

	.detail .content {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 2rem;
		gap: 2rem;
	}

	.detail .content .image {
		width: 50vw;
		aspect-ratio: 16 / 9;
		border-radius: 12px;
		overflow: hidden;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
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
		width: 50vw;
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
		<div class="image">
			<img src="https://picsum.photos/seed/{itemId}/800/450" alt={itemTitle} />
		</div>
		<div class="files">
			<div class="title">Files</div>
			{#each files as file, rowIndex (file.id)}
				<FileItem name={file.name} size={file.size} selected={rowIndex === selectedRow} {selectedButton} pressed={isAPressed} />
			{/each}
		</div>
	</div>
</div>
