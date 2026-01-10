<script lang="ts">
	interface Props {
		topLabel?: string;
		bottomLabel?: string;
		icon?: string;
		alt?: string;
	}

	const { topLabel, bottomLabel, icon, alt = '' }: Props = $props();
</script>

<style>
	.item {
		display: flex;
		align-items: center;
		flex-direction: column;
		gap: 0.6vh;
	}

	.icon {
		width: 2vh;
		height: 2vh;
	}
</style>

<div class="item">
	{#if topLabel}
		<div class="value">{topLabel}</div>
	{/if}
	{#if icon}
		<img class="icon" src={icon} {alt} />
	{/if}
	{#if bottomLabel}
		<div class="value">{bottomLabel}</div>
	{/if}
</div>
