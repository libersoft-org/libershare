<script lang="ts">
	import ProgressBar from '../ProgressBar/ProgressBar.svelte';
	interface Props {
		topIcon?: string;
		topIconAlt?: string;
		topLabel?: string;
		bottomIcon?: string;
		bottomIconAlt?: string;
		bottomLabel?: string;
		progress: number;
	}
	const { topIcon, topIconAlt, topLabel, bottomIcon, bottomIconAlt, bottomLabel, progress }: Props = $props();
</script>

<style>
	.storage {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5vh;
		min-width: 10vh;
	}

	.top,
	.bottom {
		display: flex;
		align-items: center;
		gap: 0.5vh;
	}

	.top .icon,
	.bottom .icon {
		width: 2vh;
		height: 2vh;
	}
</style>

<div class="storage">
	<div class="top">
		{#if topIcon}<img class="icon" src={topIcon} alt={topIconAlt} />{/if}
		{#if topLabel}<div class="label">{topLabel}</div>{/if}
	</div>
	<ProgressBar {progress} width="10vh" height="2vh" backgroundColor="var(--secondary-softer-background)" />
	<div class="bottom">
		{#if bottomIcon}<img class="icon" src={bottomIcon} alt={bottomIconAlt} />{/if}
		{#if bottomLabel}<div class="label">{bottomLabel}</div>{/if}
	</div>
</div>
