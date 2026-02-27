<script lang="ts">
	interface Props {
		progress: number; // 0-100
		showText?: boolean;
		width?: string;
		height?: string;
		fontSize?: string;
		backgroundColor?: string;
		color?: string;
		animated?: boolean;
	}
	let { progress, showText = true, height = '2vh', width, fontSize = '1.4vh', backgroundColor = 'var(--secondary-background)', color = 'var(--primary-foreground)', animated = false }: Props = $props();
	let clampedProgress = $derived(Math.min(100, Math.max(0, progress)));
	let barWidth = $state(0);
</script>

<style>
	.progressbar {
		position: relative;
		width: 100%;
		border: 0.3vh solid var(--bg-color);
		border-radius: calc(var(--height) / 2);
		overflow: hidden;
		background-color: var(--bg-color);
		box-sizing: border-box;
	}

	.progressbar .fill {
		position: absolute;
		top: 0;
		left: 0;
		height: 100%;
		border-radius: calc(var(--height) / 2);
		background-color: var(--fill-color);
		background-image: linear-gradient(-45deg, color-mix(in srgb, var(--primary-foreground) 85%, black) 25%, transparent 25%, transparent 50%, color-mix(in srgb, var(--primary-foreground) 85%, black) 50%, color-mix(in srgb, var(--primary-foreground) 85%, black) 75%, transparent 75%, transparent);
		background-size: 2vh 2vh;
	}

	.progressbar .fill.animated {
		animation: progress-stripes 1s linear infinite;
	}

	@keyframes progress-stripes {
		from {
			background-position: 0 0;
		}
		to {
			background-position: 2vh 0;
		}
	}

	.progressbar .text {
		position: absolute;
		top: 50%;
		font-size: var(--font-size);
		font-weight: bold;
	}

	.progressbar .text.background {
		left: 50%;
		transform: translate(-50%, -50%);
		color: var(--fill-color);
	}

	.progressbar .clip {
		position: absolute;
		top: 0;
		left: 0;
		height: 100%;
		overflow: hidden;
	}

	.progressbar .clip .text {
		left: 0;
		width: var(--bar-width);
		transform: translateY(-50%);
		text-align: center;
		color: var(--bg-color);
	}
</style>

<div class="progressbar" style="height: {height}; {width ? `width: ${width};` : ''} --height: {height}; --font-size: {fontSize}; --bg-color: {backgroundColor}; --fill-color: {color}" bind:clientWidth={barWidth}>
	<div class="fill" class:animated style="width: {clampedProgress}%"></div>
	{#if showText}
		<span class="text background">{clampedProgress.toFixed(1)}%</span>
		<div class="clip" style="width: {clampedProgress}%; --bar-width: {barWidth}px">
			<span class="text">{clampedProgress.toFixed(1)}%</span>
		</div>
	{/if}
</div>
