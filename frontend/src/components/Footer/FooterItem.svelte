<script lang="ts">
	interface Props {
		topIcon?: string;
		topIconAlt?: string;
		topLabel?: string;
		bottomIcon?: string;
		bottomIconAlt?: string;
		bottomLabel?: string;
	}

	const { topLabel, topIcon, topIconAlt = '', bottomLabel, bottomIcon, bottomIconAlt = '' }: Props = $props();
</script>

<style>
	.item {
		display: flex;
		align-items: center;
		flex-direction: column;
		gap: 0.6vh;
	}

	.top,
	.bottom {
		display: flex;
		align-items: center;
		gap: 0.5vh;
		text-align: center;
	}

	.top .icon,
	.bottom .icon {
		width: 2vh;
		height: 2vh;
	}
</style>

<div class="item">
	<div class="top">
		{#if topIcon}<img class="icon" src={topIcon} alt={topIconAlt} />{/if}
		{#if topLabel}<span class="value">{topLabel}</span>{/if}
	</div>
	<div class="bottom">
		{#if bottomIcon}<img class="icon" src={bottomIcon} alt={bottomIconAlt} />{/if}
		{#if bottomLabel}<div class="value">{bottomLabel}</div>{/if}
	</div>
</div>
