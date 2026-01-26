<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { productVersion } from '../../scripts/app.ts';
	import { volume, footerPosition, footerWidgetVisibility } from '../../scripts/settings.ts';
	import { type FooterWidget, getVolumeIcon } from '../../scripts/footerWidgets.ts';
	import Item from './FooterItem.svelte';
	import LishStatus from './FooterLISHStatus.svelte';
	import BackendStatus from './FooterBackendStatus.svelte';
	import Connection from './FooterConnection.svelte';
	import Separator from './FooterSeparator.svelte';
	import Bar from './FooterBar.svelte';
	import Clock from './FooterClock.svelte';

	import { stats } from '../../scripts/stats.ts';
	import { wsClientState } from '../../scripts/ws-client.ts';

	type Widget = {
		id: FooterWidget;
		component: typeof Item | typeof Bar | typeof Clock | typeof LishStatus | typeof BackendStatus | typeof Connection;
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
				topIcon: 'img/download.svg',
				topIconAlt: $t.common?.download,
				topLabel: '- 12',
				bottomLabel: '13.2 MB/s',
			}),
		},
		{
			id: 'upload',
			component: Item,
			props: () => ({
				topIcon: 'img/upload.svg',
				topIconAlt: $t.common?.upload,
				topLabel: '- 5',
				bottomLabel: '3.2 MB/s',
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
			id: 'backendStatus',
			component: BackendStatus,
			props: () => ({
				status: $wsClientState.connected ? 'online' : 'offline',
			}),
		},
		{
			id: 'lishStatus',
			component: LishStatus,
			props: () => ({
				networkName: 'Main Network',
				lishConnected: false,
				vpnConnected: null,
			}),
		},
		{
			id: 'connection',
			component: Connection,
			props: () => ({
				type: 'wifi',
				connected: true,
				signal: 70,
			}),
		},
		{
			id: 'volume',
			component: Item,
			props: () => ({
				topIcon: `img/${getVolumeIcon($volume)}.svg`,
				topIconAlt: $t.settings?.footerWidgets?.volume,
				bottomLabel: `${$volume}%`,
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
	<!--	<pre>-->
	<!--	&lt;!&ndash;{JSON.stringify($stats, null, 2)}&ndash;&gt;-->
	<!--	&lt;!&ndash;	{JSON.stringify($wsClientState, null, 2)}&ndash;&gt;-->
	<!--		</pre>-->
	<div class="items" class:right={$footerPosition === 'right'}>
		{#each displayWidgets as widget, i}
			{#if i > 0}<Separator />{/if}
			{@const Component = widget.component as unknown as typeof import('svelte').SvelteComponent<any>}
			<Component {...widget.props?.()} />
		{/each}
	</div>
</div>
