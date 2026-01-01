<script lang="ts">
	export let title: string = '';
	export let image: string = 'https://picsum.photos/400/225';
	export let isGamepadHovered: boolean = false;
	export let isAPressed: boolean = false;
</script>

<style>
	.item {
		position: relative;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		background-size: cover;
		background-position: center;
		background-repeat: no-repeat;
		border: 0.3vw solid #555;
		border-radius: 12px;
		overflow: hidden;
		aspect-ratio: 16 / 9;
		box-sizing: border-box;
		transition:
			transform 0.3s ease,
			border-color 0.3s ease;
	}

	.item::before {
		content: '';
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		height: 50%;
		background: linear-gradient(to top, rgba(0, 0, 0, 0.8), transparent);
		pointer-events: none;
	}

	.item.hover {
		transform: scale(1.05);
		border-color: #aa0;
	}

	.item.pressed {
		border-color: #080;
	}

	.title {
		position: relative;
		color: #fff;
		font-size: 1.2vw;
		font-weight: bold;
		padding: 1vw;
		background-color: rgba(0, 0, 0, 0.75);
		backdrop-filter: blur(4px);
	}
</style>

<div class="item" class:hover={isGamepadHovered} class:pressed={isAPressed} style="background-image: url('{image}')">
	<div class="title">{title}</div>
</div>
