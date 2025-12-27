<script lang="ts">
	import MenuButton from './MenuButton.svelte';
	
	interface Props {
		name: string;
		size: string;
		selected?: boolean;
		selectedButton?: number; // 0 = Download, 1 = Play
		pressed?: boolean;
	}
	let { name, size, selected = false, selectedButton = 0, pressed = false }: Props = $props();
</script>

<style>
	.file-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem;
		background: rgba(255, 255, 255, 0.05);
		border: 2px solid transparent;
		border-radius: 8px;
		transition: all 0.2s ease;
	}

	.file-item.selected {
		background: rgba(255, 255, 255, 0.1);
		border-color: #555;
	}

	.info {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.name {
		font-size: 1rem;
		font-weight: 500;
		color: #fff;
	}

	.size {
		font-size: 0.9rem;
		color: #888;
	}

	.actions {
		display: flex;
		gap: 1rem;
	}
</style>

<div class="file-item" class:selected>
	<div class="info">
		<div class="name">{name}</div>
		<div class="size">Size: {size}</div>
	</div>
	<div class="actions">
		<MenuButton label="Download" selected={selected && selectedButton === 0} {pressed} />
		<MenuButton label="Play" selected={selected && selectedButton === 1} {pressed} />
	</div>
</div>
