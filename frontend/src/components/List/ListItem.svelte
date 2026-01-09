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
		border: 0.5vh solid var(--secondary-soft-background);
		border-radius: 2vh;
		overflow: hidden;
		aspect-ratio: 16 / 9;
		box-sizing: border-box;
		transition: all 0.3s linear;
	}

	.item.hover {
		transform: scale(1.05);
		border-color: var(--primary-foreground);
	}

	.item.pressed {
		transform: scale(1);
	}

	.title {
		position: relative;
		color: var(--secondary-foreground);
		font-size: 2vh;
		font-weight: bold;
		padding: 1vh;
		background-color: var(--secondary-hard-background);
		opacity: 0.8;
	}
</style>

<div class="item" class:hover={isGamepadHovered} class:pressed={isAPressed} style="background-image: url('{image}')">
	<div class="title">{title}</div>
</div>
