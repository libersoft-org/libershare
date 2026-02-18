<script lang="ts">
	import { getColorFromCSSToFilter } from '../../scripts/colors.ts';
	interface Props {
		img?: string;
		alt?: string;
		size?: string;
		padding?: string;
		colorVariable?: string;
		noColorFilter?: boolean;
		badgeIcon?: string;
		badgeColorVariable?: string;
	}
	let { img, alt = '', size = '24px', padding = '10px', colorVariable, noColorFilter = false, badgeIcon, badgeColorVariable = '--color-success' }: Props = $props();
	let filterValue = $derived.by(() => {
		if (noColorFilter) return 'none';
		if (colorVariable) return getColorFromCSSToFilter(colorVariable);
		return 'none';
	});
	let badgeFilterValue = $derived.by(() => {
		const shadow = 'drop-shadow(0 0 0.4vh rgba(0, 0, 0, 1)) drop-shadow(0 0 0.4vh rgba(0, 0, 0, 1)) drop-shadow(0 0 0.4vh rgba(0, 0, 0, 1))';
		if (badgeColorVariable) return getColorFromCSSToFilter(badgeColorVariable) + ' ' + shadow;
		return shadow;
	});
</script>

<style>
	.icon {
		display: flex;
		justify-content: center;
		align-items: center;
		position: relative;
	}

	.icon img {
		display: flex;
		user-select: none;
	}

	.badge {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.badge img {
		display: flex;
		user-select: none;
	}
</style>

{#if img}
	<div class="icon" style:padding>
		<img style:min-width={size} style:min-height={size} style:max-width={size} style:max-height={size} style:filter={filterValue} src={img} draggable={false} {alt} />
		{#if badgeIcon}
			<div class="badge">
				<img style:width="calc({size} * 0.5)" style:height="calc({size} * 0.5)" style:filter={badgeFilterValue} src={badgeIcon} draggable={false} alt="" />
			</div>
		{/if}
	</div>
{/if}
