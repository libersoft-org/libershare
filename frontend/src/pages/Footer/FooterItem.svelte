<script lang="ts">
	import Icon from '../../components/Icon/Icon.svelte';
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
</style>

<div class="item">
	<div class="top">
		{#if topIcon}<Icon img={topIcon} alt={topIconAlt} size="2vh" padding="0" colorVariable="--primary-foreground" />{/if}
		{#if topLabel}<span class="value">{topLabel}</span>{/if}
	</div>
	<div class="bottom">
		{#if bottomIcon}<Icon img={bottomIcon} alt={bottomIconAlt} size="2vh" padding="0" colorVariable="--primary-foreground" />{/if}
		{#if bottomLabel}<div class="value">{bottomLabel}</div>{/if}
	</div>
</div>
