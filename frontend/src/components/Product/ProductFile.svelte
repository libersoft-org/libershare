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
		flex-wrap: wrap;
		gap: 1vh;
		padding: 2vh;
		background-color: var(--secondary-background);
		border: 0.4vh solid var(--secondary-softer-background);
		border-radius: 2vh;
		transition: all 0.2s linear;
	}

	.filerow.selected {
		background-color: var(--secondary-hard-background);
		border-color: var(--primary-foreground);
	}

	.filerow .info {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.5vh;
	}

	.filerow .info .name {
		font-size: 3vh;
		font-weight: bold;
		color: var(--secondary-foreground);
	}

	.filerow .info .size {
		font-size: 2vh;
		color: var(--disabled-foreground);
	}

	.filerow .actions {
		display: flex;
		gap: 2vh;
	}

	@media (max-width: 768px) {
		.filerow .actions {
			width: 100%;
		}

		.filerow .actions :global(.button) {
			flex: 1;
			min-width: unset;
		}
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
