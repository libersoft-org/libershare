<script lang="ts">
	interface Props {
		icon: string;
		value: string;
		alt?: string;
	}

	const { icon, value, alt = '' }: Props = $props();
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
	<div class="value">{value}</div>
	<img class="icon" src="/img/{icon}.svg" {alt} />
</div>
