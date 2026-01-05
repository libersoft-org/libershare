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
		padding: 1vw;
		background-color: rgba(255, 255, 255, 0.1);
		border: 2px solid rgba(255, 255, 255, 0.3);
		border-radius: 1vw;
		font-size: 1vw;
		color: #fff;
		text-align: center;
		white-space: nowrap;
		transition: all 0.2s linear;
		backdrop-filter: blur(10px);
		opacity: 0.6;
		box-sizing: border-box;
		min-width: 8vw;
	}

	.menu-button.selected {
		background-color: rgba(255, 221, 17, 0.2);
		color: #fd1;
		border-color: #fd1;
		border-width: 0.1vw;
		box-shadow: 0 0 1vw rgba(255, 221, 17, 0.6);
		font-weight: bold;
		opacity: 1;
		transform: scale(1.05);
	}

	.menu-button.selected.pressed {
		transform: scale(1);
		background-color: rgba(255, 221, 17, 0.4);
	}
</style>

<div class="menu-button" class:selected class:pressed={selected && pressed}>
	{label}
</div>
