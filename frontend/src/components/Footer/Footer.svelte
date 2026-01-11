<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { productVersion } from '../../scripts/app.ts';
	import { volume, footerPosition } from '../../scripts/settings.ts';
	import Item from './FooterItem.svelte';
	import Separator from './FooterSeparator.svelte';
	import Bar from './FooterBar.svelte';
	import Clock from './FooterClock.svelte';

	const widgets = [
		{ component: Item, props: () => ({ topLabel: $t.common?.version, bottomLabel: productVersion, alt: $t.common?.version }) },
		{ component: Separator },
		{ component: Item, props: () => ({ icon: 'img/download.svg', topLabel: '12.5 MB/s', alt: $t.common?.download }) },
		{ component: Separator },
		{ component: Item, props: () => ({ icon: 'img/upload.svg', topLabel: '3.2 MB/s', alt: $t.common?.upload }) },
		{ component: Separator },
		{ component: Bar, props: () => ({ topLabel: 'CPU', progress: 12 }) },
		{ component: Separator },
		{ component: Bar, props: () => ({ topLabel: 'RAM - 12.1 / 32 GB', progress: 32 }) },
		{ component: Separator },
		{ component: Bar, props: () => ({ topLabel: 'STORAGE - 0.88 / 2 TB', progress: 44.1 }) },
		{ component: Separator },
		{ component: Item, props: () => ({ icon: 'img/volume.svg', topLabel: `${$volume}%`, alt: $t.common?.volume }) },
		{ component: Separator },
		{ component: Clock },
	];

	let displayWidgets = $derived($footerPosition === 'right' ? [...widgets].reverse() : widgets);
</script>

<style>
	.footer {
		display: flex;
		align-items: center;
		background-color: var(--secondary-background);
		color: var(--primary-foreground);
		padding: 1vh 1.5vh;
		font-size: 1.6vh;
		border-block: 0.2vh solid var(--secondary-softer-background);
	}

	.footer.left {
		justify-content: flex-start;
	}

	.footer.right {
		justify-content: flex-end;
	}

	.items {
		display: flex;
		align-items: center;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.items.right {
		flex-direction: row-reverse;
	}

	.items::-webkit-scrollbar {
		display: none;
	}
</style>

<div class="footer" class:left={$footerPosition === 'left'} class:right={$footerPosition === 'right'}>
	<div class="items" class:right={$footerPosition === 'right'}>
		{#each displayWidgets as widget}
			<svelte:component this={widget.component} {...widget.props?.()} />
		{/each}
	</div>
</div>
