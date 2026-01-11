<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { productVersion } from '../../scripts/app.ts';
	import { volume, footerPosition, footerWidgetVisibility, type FooterWidget } from '../../scripts/settings.ts';
	import Item from './FooterItem.svelte';
	import Separator from './FooterSeparator.svelte';
	import Bar from './FooterBar.svelte';
	import Clock from './FooterClock.svelte';

	type Widget = {
		id?: FooterWidget;
		component: typeof Item | typeof Separator | typeof Bar | typeof Clock;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		props?: () => Record<string, any>;
	};

	const allWidgets: Widget[] = [
		{ id: 'version', component: Item, props: () => ({ topLabel: $t.common?.version, bottomLabel: productVersion, alt: $t.common?.version }) },
		{ component: Separator },
		{ id: 'download', component: Item, props: () => ({ icon: 'img/download.svg', topLabel: '12.5 MB/s', alt: $t.common?.download }) },
		{ component: Separator },
		{ id: 'upload', component: Item, props: () => ({ icon: 'img/upload.svg', topLabel: '3.2 MB/s', alt: $t.common?.upload }) },
		{ component: Separator },
		{ id: 'cpu', component: Bar, props: () => ({ topLabel: 'CPU', progress: 12 }) },
		{ component: Separator },
		{ id: 'ram', component: Bar, props: () => ({ topLabel: 'RAM - 12.1 / 32 GB', progress: 32 }) },
		{ component: Separator },
		{ id: 'storage', component: Bar, props: () => ({ topLabel: 'STORAGE - 0.88 / 2 TB', progress: 44.1 }) },
		{ component: Separator },
		{ id: 'volume', component: Item, props: () => ({ icon: 'img/volume.svg', topLabel: `${$volume}%`, alt: $t.common?.volume }) },
		{ component: Separator },
		{ id: 'clock', component: Clock },
	];

	// Filter out disabled widgets and their adjacent separators
	let visibleWidgets = $derived.by(() => {
		const result: Widget[] = [];
		let lastWasWidget = false;

		for (const widget of allWidgets) {
			if (widget.id) {
				// It's a real widget - check visibility
				if ($footerWidgetVisibility[widget.id]) {
					result.push(widget);
					lastWasWidget = true;
				}
			} else {
				// It's a separator - only add if previous was a visible widget
				if (lastWasWidget) {
					result.push(widget);
					lastWasWidget = false;
				}
			}
		}

		// Remove trailing separator if present
		if (result.length > 0 && !result[result.length - 1].id) {
			result.pop();
		}

		return result;
	});

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
		{#each displayWidgets as widget}
			<svelte:component this={widget.component} {...widget.props?.()} />
		{/each}
	</div>
</div>
