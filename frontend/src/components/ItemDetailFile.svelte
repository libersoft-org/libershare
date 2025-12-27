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
	.filerow {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1vw;
		background: rgba(255, 255, 255, 0.05);
		border: 0.2vw solid transparent;
		border-color: rgba(255, 255, 255, 0.05);
		border-radius: 1vw;
		transition: all 0.3s ease;
	}

	.filerow.selected {
		background: rgba(255, 255, 255, 0.1);
		border-color: rgba(255, 255, 255, 0.3);
	}

	.info {
		display: flex;
		flex-direction: column;
		gap: 0.5vw;
	}

	.info .name {
		font-size: 1.2vw;
		font-weight: bold;
		color: #fff;
	}

	.info .size {
		font-size: 1vw;
		color: #888;
	}

	.actions {
		display: flex;
		gap: 1vw;
	}
</style>

<div class="filerow" class:selected>
	<div class="info">
		<div class="name">{name}</div>
		<div class="size">Size: {size}</div>
	</div>
	<div class="actions">
		<MenuButton label="Download" selected={selected && selectedButton === 0} {pressed} />
		<MenuButton label="Play" selected={selected && selectedButton === 1} {pressed} />
	</div>
</div>
