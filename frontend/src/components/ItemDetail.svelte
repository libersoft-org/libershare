<script lang="ts">
	import { onMount } from 'svelte';
	import { useInput } from '../scripts/input';
	import MenuButton from './MenuButton.svelte';
	
	interface Props {
		category?: string;
		itemTitle?: string;
		itemId?: number;
		onback?: () => void;
	}
	let { category = 'Movies', itemTitle = 'Item', itemId = 1, onback }: Props = $props();
	
	// Mock files data
	const files = [
		{ id: 1, name: `${itemTitle} (2025) 1080p CZ EN.mkv`, size: '10.5 GB' },
		{ id: 2, name: `${itemTitle} (2025) 2160p CZ EN.mkv`, size: '26.8 GB' },
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
			confirmUp: () => { isAPressed = false; },
			back: () => onback?.()
		});
	});
</script>

<style>
	.detail-container {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
		color: #fff;
	}
	
	.breadcrumb {
		width: 100%;
		padding: 1rem 2rem;
		background: rgba(0, 0, 0, 0.5);
		font-size: 1.2rem;
		box-sizing: border-box;
	}
	
	.breadcrumb span {
		color: #888;
	}
	
	.breadcrumb .current {
		color: #fff;
		font-weight: bold;
	}
	
	.content {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 2rem;
		gap: 2rem;
	}
	
	.image-container {
		width: 50vw;
		aspect-ratio: 16 / 9;
		border-radius: 12px;
		overflow: hidden;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
	}
	
	.image-container img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	
	.files-section {
		width: 50vw;
	}
	
	.files-title {
		font-size: 1.5rem;
		font-weight: bold;
		margin-bottom: 1rem;
		padding-bottom: 0.5rem;
		border-bottom: 2px solid #444;
	}
	
	.file-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem;
		background: rgba(255, 255, 255, 0.05);
		border: 2px solid transparent;
		border-radius: 8px;
		margin-bottom: 0.5rem;
		transition: all 0.2s ease;
	}
	
	.file-row.selected {
		background: rgba(255, 255, 255, 0.1);
		border-color: #555;
	}
	
	.file-info {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	
	.file-name {
		font-size: 1rem;
		font-weight: 500;
	}
	
	.file-size {
		font-size: 0.9rem;
		color: #888;
	}
	
	.file-actions {
		display: flex;
		gap: 1rem;
	}
</style>

<div class="detail-container">
	<div class="breadcrumb">
		<span>{category}</span> &gt; <span class="current">{itemTitle} (2016)</span>
	</div>
	
	<div class="content">
		<div class="image-container">
			<img src="https://picsum.photos/seed/{itemId}/800/450" alt={itemTitle} />
		</div>
		
		<div class="files-section">
			<div class="files-title">Files</div>
			{#each files as file, rowIndex (file.id)}
				<div class="file-row" class:selected={rowIndex === selectedRow}>
					<div class="file-info">
						<div class="file-name">{file.name}</div>
						<div class="file-size">Size: {file.size}</div>
					</div>
					<div class="file-actions">
						<MenuButton 
							label="Download" 
							selected={rowIndex === selectedRow && selectedButton === 0}
							pressed={isAPressed}
						/>
						<MenuButton 
							label="Play" 
							selected={rowIndex === selectedRow && selectedButton === 1}
							pressed={isAPressed}
						/>
					</div>
				</div>
			{/each}
		</div>
	</div>
</div>
