<script lang="ts">
	export let title: string = '';
	export let isGamepadHovered: boolean = false;
	export let isAPressed: boolean = false;
</script>

<style>
	.item {
		display: flex;
		flex-direction: column;
		gap: 1vw;
		background: #222;
		border: 0.5vw solid #555;
		border-radius: 12px;
		padding: 1.5rem;
		backdrop-filter: blur(10px);
		transition:
			transform 0.2s ease,
			box-shadow 0.2s ease;
		height: 100%;
		box-sizing: border-box;
	}

	.item.hover {
		transform: scale(1.1);
		border-color: #800;
	}

	.item.a-pressed {
		border-color: #080;
	}

	.title {
		color: #fff;
		font-size: 1.2vw;
		font-weight: bold;
	}
</style>

<div class="item" class:hover={isGamepadHovered} class:a-pressed={isAPressed}>
	<div class="title">{title}</div>
</div>
