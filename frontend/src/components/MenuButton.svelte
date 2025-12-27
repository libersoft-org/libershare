<script lang="ts">
	interface Props {
		label: string;
		selected?: boolean;
		pressed?: boolean;
	}
	let { label, selected = false, pressed = false }: Props = $props();
</script>

<style>
	.menu-button {
		padding: 1.2rem 2.5rem;
		background: rgba(255, 255, 255, 0.15);
		border: 2px solid rgba(255, 255, 255, 0.3);
		border-radius: 12px;
		font-size: 1.4rem;
		color: #fff;
		text-align: center;
		white-space: nowrap;
		transition: all 0.2s ease;
		backdrop-filter: blur(10px);
		opacity: 0.6;
		box-sizing: border-box;
		min-width: 200px;
	}

	.menu-button.selected {
		background: rgba(255, 255, 255, 0.3);
		border-color: #fff;
		border-width: 3px;
		box-shadow: 0 0 25px rgba(255, 255, 255, 0.5);
		font-weight: bold;
		opacity: 1;
		transform: scale(1.05);
	}

	.menu-button.selected.pressed {
		transform: scale(1);
		background: rgba(255, 255, 255, 0.4);
	}
</style>

<div class="menu-button" class:selected class:pressed={selected && pressed}>
	{label}
</div>
