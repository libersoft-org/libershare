<script lang="ts">
	interface Props {
		progress: number; // 0-100
		showText?: boolean;
		height?: string;
	}
	let { progress, showText = true, height = '2vh' }: Props = $props();
	let clampedProgress = $derived(Math.min(100, Math.max(0, progress)));
	let barWidth = $state(0);
</script>

<style>
	.progressbar {
		position: relative;
		width: 100%;
		border-radius: calc(var(--height) / 2);
		overflow: hidden;
		background-color: var(--secondary-background);
	}

	.progressbar .fill {
		position: absolute;
		top: 0;
		left: 0;
		height: 100%;
		border-radius: calc(var(--height) / 2);
		background-color: var(--primary-foreground);
	}

	.progressbar .text {
		position: absolute;
		top: 50%;
		font-size: 1.2vh;
		font-weight: bold;
	}

	.progressbar .text.background {
		left: 50%;
		transform: translate(-50%, -50%);
		color: var(--primary-foreground);
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
		color: var(--secondary-background);
	}
</style>

<div class="progressbar" style="height: {height}; --height: {height}" bind:clientWidth={barWidth}>
	<div class="fill" style="width: {clampedProgress}%"></div>
	{#if showText}
		<span class="text background">{clampedProgress.toFixed(1)}%</span>
		<div class="clip" style="width: {clampedProgress}%; --bar-width: {barWidth}px">
			<span class="text">{clampedProgress.toFixed(1)}%</span>
		</div>
	{/if}
</div>
