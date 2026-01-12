<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { productVersion } from '../../scripts/app.ts';
	import { volume, footerPosition, footerWidgetVisibility } from '../../scripts/settings.ts';
	import { type FooterWidget } from '../../scripts/footerWidgets.ts';
	import Item from './FooterItem.svelte';
	import Separator from './FooterSeparator.svelte';
	import Bar from './FooterBar.svelte';
	import Clock from './FooterClock.svelte';
	type Widget = {
		id: FooterWidget;
		component: typeof Item | typeof Bar | typeof Clock;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		props?: () => Record<string, any>;
	};
	const widgets: Widget[] = [
		{
			id: 'version',
			component: Item,
			props: () => ({
				topLabel: $t.common?.version,
				bottomLabel: productVersion,
			}),
		},
		{
			id: 'download',
			component: Item,
			props: () => ({
				topLabel: '12.5 MB/s',
				bottomIcon: 'img/download.svg',
				bottomIconAlt: $t.common?.download,
			}),
		},
		{
			id: 'upload',
			component: Item,
			props: () => ({
				topLabel: '3.2 MB/s',
				bottomIcon: 'img/upload.svg',
				bottomIconAlt: $t.common?.upload,
			}),
		},
		{
			id: 'cpu',
			component: Bar,
			props: () => ({
				topIcon: 'img/cpu.svg',
				topIconAlt: $t.settings?.footerWidgets?.cpu,
				progress: 12,
			}),
		},
		{
			id: 'ram',
			component: Bar,
			props: () => ({
				topIcon: 'img/ram.svg',
				topIconAlt: $t.settings?.footerWidgets?.ram,
				topLabel: '12.1 / 32 GB',
				progress: 32,
			}),
		},
		{
			id: 'storage',
			component: Bar,
			props: () => ({
				topIcon: 'img/storage.svg',
				topIconAlt: $t.settings?.footerWidgets?.storage,
				topLabel: '0.88 / 2 TB',
				progress: 44.1,
			}),
		},
		{
			id: 'volume',
			component: Item,
			props: () => ({
				topLabel: `${$volume}%`,
				bottomIcon: 'img/volume.svg',
				bottomIconAlt: $t.settings?.footerWidgets?.volume,
			}),
		},
		{
			id: 'clock',
			component: Clock,
		},
	];

	// Filter visible widgets
	let visibleWidgets = $derived(widgets.filter(w => $footerWidgetVisibility[w.id]));
	let displayWidgets = $derived($footerPosition === 'right' ? [...visibleWidgets].reverse() : visibleWidgets);
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

	.footer.center {
		justify-content: center;
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

<div class="footer" class:left={$footerPosition === 'left'} class:center={$footerPosition === 'center'} class:right={$footerPosition === 'right'}>
	<div class="items" class:right={$footerPosition === 'right'}>
		{#each displayWidgets as widget, i}
			{#if i > 0}<Separator />{/if}
			{@const Component = widget.component as unknown as typeof import('svelte').SvelteComponent<any>}
			<Component {...widget.props?.()} />
		{/each}
	</div>
</div>
