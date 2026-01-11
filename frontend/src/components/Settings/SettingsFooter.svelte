<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { navigateTo } from '../../scripts/navigation.ts';
	import { footerVisible, setFooterVisible, footerPosition, footerWidgetVisibility, setFooterWidgetVisibility } from '../../scripts/settings.ts';
	import { footerWidgets, type FooterWidget } from '../../scripts/footerWidgets.ts';
	import { useArea, activeArea } from '../../scripts/areas.ts';
	import Button from '../Buttons/Button.svelte';
	import Switch from '../Switch/Switch.svelte';

	function getWidgetLabel(widget: FooterWidget): string {
		const labels: Record<FooterWidget, string> = {
			version: $t.common?.version,
			download: $t.settings?.footerWidgets?.download,
			upload: $t.settings?.footerWidgets?.upload,
			cpu: $t.settings?.footerWidgets?.cpu,
			ram: $t.settings?.footerWidgets?.ram,
			storage: $t.settings?.footerWidgets?.storage,
			volume: $t.settings?.footerWidgets?.volume,
			clock: $t.settings?.footerWidgets?.clock,
		};
		return labels[widget] ?? widget;
	}
	interface Props {
		areaID: string;
		onBack?: () => void;
	}
	let { areaID, onBack }: Props = $props();
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0);
	// 0 = visibility switch, 1 = position button, 2+ = widget rows, last = back button
	const totalItems = 3 + footerWidgets.length;

	function openPositionDialog() {
		navigateTo('footer-position');
	}

	onMount(() => {
		return useArea(areaID, {
			up: () => {
				if (selectedIndex > 0) {
					selectedIndex--;
					scrollToSelected();
					return true;
				}
				return false;
			},
			down: () => {
				if (selectedIndex < totalItems - 1) {
					selectedIndex++;
					scrollToSelected();
					return true;
				}
				return false;
			},
			left: () => {
				// Toggle switch off
				if (selectedIndex === 0) {
					if ($footerVisible) {
						setFooterVisible(false);
						return true;
					}
				} else if (selectedIndex > 1 && selectedIndex < totalItems - 1) {
					const widget = footerWidgets[selectedIndex - 2];
					if ($footerWidgetVisibility[widget]) {
						setFooterWidgetVisibility(widget, false);
						return true;
					}
				}
				return false;
			},
			right: () => {
				// Toggle switch on
				if (selectedIndex === 0) {
					if (!$footerVisible) {
						setFooterVisible(true);
						return true;
					}
				} else if (selectedIndex > 1 && selectedIndex < totalItems - 1) {
					const widget = footerWidgets[selectedIndex - 2];
					if (!$footerWidgetVisibility[widget]) {
						setFooterWidgetVisibility(widget, true);
						return true;
					}
				}
				return false;
			},
			confirmDown: () => {},
			confirmUp: () => {
				if (selectedIndex === 0)
					setFooterVisible(!$footerVisible); // Toggle footer visibility
				else if (selectedIndex === 1) openPositionDialog();
				else if (selectedIndex === totalItems - 1)
					onBack?.(); // Back button
				else {
					// Toggle the widget switch
					const widget = footerWidgets[selectedIndex - 2];
					setFooterWidgetVisibility(widget, !$footerWidgetVisibility[widget]);
				}
			},
			confirmCancel: () => {},
			back: () => onBack?.(),
		});
	});

	let rowElements: HTMLElement[] = $state([]);

	function scrollToSelected(): void {
		const element = rowElements[selectedIndex];
		if (element) {
			element.scrollIntoView({
				behavior: 'smooth',
				block: 'center',
			});
		}
	}
</script>

<style>
	.footer {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
	}

	.content {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 2vh;
		gap: 2vh;
		overflow-y: auto;
	}

	.table {
		display: flex;
		flex-direction: column;
		border: 0.2vh solid var(--secondary-softer-background);
		border-radius: 1vh;
		overflow: hidden;
		width: 100%;
		max-width: 60vh;
		color: var(--secondary-foreground);
	}

	.table .row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1.5vh 2vh;
		border-bottom: 0.2vh solid var(--secondary-softer-background);
	}

	.table .row:last-child {
		border-bottom: none;
	}

	.table .row.odd {
		background-color: var(--secondary-soft-background);
	}

	.table .row.even {
		background-color: var(--secondary-background);
	}

	.table .row.selected {
		background-color: var(--primary-foreground);
		color: var(--primary-background);
	}

	.table .row .name {
		font-size: 2vh;
		font-weight: 500;
	}

	.back {
		margin-top: 2vh;
	}
</style>

<div class="footer">
	<div class="content">
		<div class="table">
			<div class="row odd" class:selected={active && selectedIndex === 0} bind:this={rowElements[0]}>
				<span class="name">{$t.settings?.footerVisible}</span>
				<Switch checked={$footerVisible} />
			</div>
		</div>
		<div bind:this={rowElements[1]}>
			<Button label="{$t.settings?.footerPosition}: {$t.settings?.footerPositions?.[$footerPosition]}" selected={active && selectedIndex === 1} onConfirm={openPositionDialog} />
		</div>
		<div class="table">
			{#each footerWidgets as widget, index}
				<div class="row" class:odd={index % 2 === 0} class:even={index % 2 === 1} class:selected={active && selectedIndex === index + 2} bind:this={rowElements[index + 2]}>
					<div class="name">{getWidgetLabel(widget)}</div>
					<Switch checked={$footerWidgetVisibility[widget]} />
				</div>
			{/each}
		</div>
		<div class="back" bind:this={rowElements[totalItems - 1]}>
			<Button label={$t.common?.back} selected={active && selectedIndex === totalItems - 1} onConfirm={onBack} />
		</div>
	</div>
</div>
