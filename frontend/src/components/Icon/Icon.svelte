<script lang="ts">
	import { getColorFromCSSToFilter } from '../../scripts/colors.ts';
	interface Props {
		img?: string;
		alt?: string;
		size?: string;
		padding?: string;
		colorVariable?: string;
	}
	let { img, alt = '', size = '24px', padding = '10px', colorVariable }: Props = $props();
	let filter = $derived.by(() => {
		if (colorVariable) return 'filter: ' + getColorFromCSSToFilter(colorVariable);
		return '';
	});
</script>

<style>
	.icon {
		display: flex;
		justify-content: center;
		align-items: center;
	}

	.icon img {
		display: flex;
		user-select: none;
	}
</style>

{#if img}
	<div class="icon" style:padding>
		<img style:min-width={size} style:min-height={size} style:max-width={size} style:max-height={size} style={filter} src={img} draggable={false} {alt} />
	</div>
{/if}
