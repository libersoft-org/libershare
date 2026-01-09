<script lang="ts">
	interface Props {
		progress: number; // 0-100
		completed?: boolean;
		showText?: boolean;
		height?: string;
	}
	let { progress, completed = false, showText = true, height = '2vh' }: Props = $props();
	let clampedProgress = $derived(Math.min(100, Math.max(0, progress)));
</script>

<style>
	.progress-bar {
		position: relative;
		width: 100%;
		background-color: var(--disabled-background);
		border-radius: 1vh;
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		border-radius: 1vh;
		transition: width 0.3s ease;
		background-color: var(--primary-background);
	}

	.progress-fill.completed {
		background-color: var(--secondary-background);
	}

	.progress-text {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		font-size: 1.2vh;
		font-weight: bold;
		color: var(--primary-foreground);
		text-shadow: 0 0 2px rgba(0, 0, 0, 0.5);
	}
</style>

<div class="progress-bar" style="height: {height}">
	<div class="progress-fill" class:completed style="width: {clampedProgress}%"></div>
	{#if showText}
		<span class="progress-text">{clampedProgress.toFixed(1)}%</span>
	{/if}
</div>
