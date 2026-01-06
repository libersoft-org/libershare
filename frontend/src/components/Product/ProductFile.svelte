<script lang="ts">
	import Button from '../Buttons/Button.svelte';
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
		background-color: rgba(255, 255, 255, 0.05);
		border: 0.2vw solid rgba(255, 255, 255, 0.05);
		border-radius: 1vw;
		transition: all 0.2s linear;
	}

	.filerow.selected {
		background-color: rgba(255, 255, 255, 0.1);
		border-color: #aa0;
	}

	.filerow .info {
		display: flex;
		flex-direction: column;
		gap: 0.5vw;
	}

	.filerow .info .name {
		font-size: 1.2vw;
		font-weight: bold;
		color: #fff;
	}

	.filerow .info .size {
		font-size: 1vw;
		color: #888;
	}

	.filerow .actions {
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
		<Button label="Download" selected={selected && selectedButton === 0} {pressed} />
		<Button label="Play" selected={selected && selectedButton === 1} {pressed} />
	</div>
</div>
