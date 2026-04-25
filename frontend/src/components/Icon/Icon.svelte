<script lang="ts">
	interface Props {
		img?: string | undefined;
		alt?: string | undefined;
		size?: string | undefined;
		padding?: string | undefined;
		colorVariable?: string | undefined;
		noColorFilter?: boolean | undefined;
		badgeIcon?: string | undefined;
		badgeColorVariable?: string | undefined;
	}
	let { img, alt = '', size = '24px', padding = '10px', colorVariable, noColorFilter = false, badgeIcon, badgeColorVariable = '--color-success' }: Props = $props();
	let useMask = $derived(!!colorVariable && !noColorFilter);
</script>

<style>
	.icon {
		display: flex;
		justify-content: center;
		align-items: center;
		position: relative;
	}

	.icon-img {
		display: flex;
		user-select: none;
		mask-size: contain;
		mask-repeat: no-repeat;
		mask-position: center;
		-webkit-mask-size: contain;
		-webkit-mask-repeat: no-repeat;
		-webkit-mask-position: center;
	}

	.icon-img-plain {
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

	.badge-img {
		display: flex;
		user-select: none;
		mask-size: contain;
		mask-repeat: no-repeat;
		mask-position: center;
		-webkit-mask-size: contain;
		-webkit-mask-repeat: no-repeat;
		-webkit-mask-position: center;
		filter: drop-shadow(0 0 0.4vh rgba(0, 0, 0, 1)) drop-shadow(0 0 0.4vh rgba(0, 0, 0, 1)) drop-shadow(0 0 0.4vh rgba(0, 0, 0, 1));
	}
</style>

{#if img}
	<div class="icon" style:padding>
		{#if useMask}
			<div class="icon-img" role="img" aria-label={alt} style:min-width={size} style:min-height={size} style:max-width={size} style:max-height={size} style:background-color="var({colorVariable})" style:mask-image="url('{img}')" style:-webkit-mask-image="url('{img}')"></div>
		{:else}
			<img class="icon-img-plain" style:min-width={size} style:min-height={size} style:max-width={size} style:max-height={size} src={img} draggable={false} {alt} />
		{/if}
		{#if badgeIcon}
			<div class="badge">
				<div class="badge-img" role="presentation" style:width="calc({size} * 0.5)" style:height="calc({size} * 0.5)" style:background-color="var({badgeColorVariable})" style:mask-image="url('{badgeIcon}')" style:-webkit-mask-image="url('{badgeIcon}')"></div>
			</div>
		{/if}
	</div>
{/if}
