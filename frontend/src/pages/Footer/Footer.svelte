<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { productVersion } from '@shared';
	import { volume, volumeAvailable, volumeKnown, footerPosition, footerWidgetVisibility } from '../../scripts/settings.ts';
	import { type FooterWidget, getVolumeIcon } from '../../scripts/footerWidgets.ts';
	import Item from './FooterItem.svelte';
	import LISHStatus from './FooterLISHStatus.svelte';
	import Gamepad from './FooterGamepad.svelte';
	import Connection from './FooterConnection.svelte';
	import Separator from './FooterSeparator.svelte';
	import Bar from './FooterBar.svelte';
	import Clock from './FooterClock.svelte';
	import { gamepadConnected } from '../../scripts/input/gamepad.ts';
	import { ramInfo, storageInfo, cpuInfo } from '../../scripts/systemStats.ts';
	import { formatSize } from '../../scripts/utils.ts';
	import { transferStats } from '../../scripts/downloads.ts';
	import { relayStats } from '../../scripts/relayStats.ts';
	import { networkSummary, meshStatus } from '../../scripts/networks.ts';

	type Widget = {
		id: FooterWidget;
		component: typeof Item | typeof Bar | typeof Clock | typeof LISHStatus | typeof Gamepad | typeof Connection;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		props?: () => Record<string, any>;
	};

	const widgets: Widget[] = [
		{
			id: 'version',
			component: Item,
			props(): Record<string, any> {
				return {
					topLabel: $t('common.version'),
					bottomLabel: productVersion,
				};
			},
		},
		{
			id: 'download',
			component: Item,
			props(): Record<string, any> {
				return {
					topIcon: 'img/download.svg',
					topIconAlt: $t('common.download'),
					topLabel: `${$transferStats.downloadPeers}`,
					bottomLabel: formatSize($transferStats.downloadSpeed) + '/s',
				};
			},
		},
		{
			id: 'upload',
			component: Item,
			props(): Record<string, any> {
				return {
					topIcon: 'img/upload.svg',
					topIconAlt: $t('common.upload'),
					topLabel: `${$transferStats.uploadPeers}`,
					bottomLabel: formatSize($transferStats.uploadSpeed) + '/s',
				};
			},
		},
		{
			id: 'relay',
			component: Item,
			props(): Record<string, any> {
				return {
					topIcon: 'img/share.svg',
					topIconAlt: $t('settings.footerWidgets.relay'),
					topLabel: `${$relayStats.activeTunnels} / ${$relayStats.reservations}`,
					bottomLabel: formatSize($relayStats.downloadSpeed + $relayStats.uploadSpeed) + '/s',
				};
			},
		},
		{
			id: 'cpu',
			component: Bar,
			props(): Record<string, any> {
				return {
					topIcon: 'img/cpu.svg',
					topIconAlt: $t('settings.footerWidgets.cpu'),
					progress: $cpuInfo.usage,
				};
			},
		},
		{
			id: 'ram',
			component: Bar,
			props(): Record<string, any> {
				return {
					topIcon: 'img/ram.svg',
					topIconAlt: $t('settings.footerWidgets.ram'),
					topLabel: `${formatSize($ramInfo.used)} / ${formatSize($ramInfo.total)}`,
					progress: $ramInfo.total > 0 ? ($ramInfo.used / $ramInfo.total) * 100 : 0,
				};
			},
		},
		{
			id: 'storage',
			component: Bar,
			props(): Record<string, any> {
				return {
					topIcon: 'img/storage.svg',
					topIconAlt: $t('settings.footerWidgets.storage'),
					topLabel: `${formatSize($storageInfo.used)} / ${formatSize($storageInfo.total)}`,
					progress: $storageInfo.total > 0 ? ($storageInfo.used / $storageInfo.total) * 100 : 0,
				};
			},
		},
		{
			id: 'lishStatus',
			component: LISHStatus,
			props(): Record<string, any> {
				return {
					connectedNetworks: $networkSummary.connectedNetworks,
					totalNetworks: $networkSummary.totalNetworks,
					totalPeers: $networkSummary.totalPeers,
					meshState: $meshStatus.state,
				};
			},
		},
		{
			id: 'gamepad',
			component: Gamepad,
			props(): Record<string, any> {
				return {
					connected: $gamepadConnected,
				};
			},
		},
		{
			id: 'connection',
			component: Connection,
			props(): Record<string, any> {
				return {
					type: 'wifi',
					connected: true,
					signal: 70,
				};
			},
		},
		{
			id: 'volume',
			component: Item,
			props(): Record<string, any> {
				// Until the first live reading arrives, show a neutral placeholder
				// rather than the persisted value (which would flicker to the OS value).
				if (!$volumeKnown) {
					return {
						topIcon: `img/${getVolumeIcon($volume)}.svg`,
						topIconAlt: $t('settings.footerWidgets.volume'),
						bottomLabel: '—',
					};
				}
				if (!$volumeAvailable) {
					const label = $t('settings.footerWidgets.volumeUnavailable');
					return {
						topIcon: 'img/volumeOff.svg',
						topIconAlt: label,
						title: label,
						bottomLabel: '—',
					};
				}
				return {
					topIcon: `img/${getVolumeIcon($volume)}.svg`,
					topIconAlt: $t('settings.footerWidgets.volume'),
					bottomLabel: `${$volume}%`,
				};
			},
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

<div class="footer" data-footer class:left={$footerPosition === 'left'} class:center={$footerPosition === 'center'} class:right={$footerPosition === 'right'}>
	<div class="items" class:right={$footerPosition === 'right'}>
		{#each displayWidgets as widget, i}
			{#if i > 0}<Separator />{/if}
			{@const Component = widget.component as unknown as typeof import('svelte').SvelteComponent<any>}
			<Component {...widget.props?.()} />
		{/each}
	</div>
</div>
