<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { pushBreadcrumb, popBreadcrumb } from '../../scripts/navigation.ts';
	import { footerVisible, setFooterVisible, footerPosition, footerWidgets, footerWidgetVisibility, setFooterWidgetVisibility, type FooterWidget } from '../../scripts/settings.ts';
	import { useArea, activeArea } from '../../scripts/areas.ts';
	import Button from '../Buttons/Button.svelte';
	import Switch from '../Switch/Switch.svelte';
	import SettingsFooterPosition from './SettingsFooterPosition.svelte';
	interface Props {
		areaID: string;
		onBack?: () => void;
	}
	let { areaID, onBack }: Props = $props();
	let showPositionDialog = $state(false);
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0);
	// 0 = visibility switch, 1 = position button, 2+ = widget rows, last = back button
	const totalItems = 3 + footerWidgets.length;

	function openPositionDialog() {
		pushBreadcrumb($t.settings?.footerPosition ?? '');
		showPositionDialog = true;
	}

	function closePositionDialog() {
		popBreadcrumb();
		showPositionDialog = false;
	}

	function registerHandlers() {
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
				if (selectedIndex === 0) {
					// Toggle footer visibility
					setFooterVisible(!$footerVisible);
				} else if (selectedIndex === 1) {
					openPositionDialog();
				} else if (selectedIndex === totalItems - 1) {
					// Back button
					onBack?.();
				} else {
					// Toggle the widget switch
					const widget = footerWidgets[selectedIndex - 2];
					setFooterWidgetVisibility(widget, !$footerWidgetVisibility[widget]);
				}
			},
			confirmCancel: () => {},
			back: () => {
				onBack?.();
			},
		});
	}

	// Register handlers when not showing position dialog
	$effect(() => {
		if (!showPositionDialog) {
			const unregister = registerHandlers();
			return unregister;
		}
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
	.footer-settings {
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

	.widgets-table {
		display: flex;
		flex-direction: column;
		border: 0.2vh solid var(--secondary-softer-background);
		border-radius: 1vh;
		overflow: hidden;
		width: 100%;
		max-width: 60vh;
	}

	.widget-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1.5vh 2vh;
		border-bottom: 0.2vh solid var(--secondary-softer-background);
	}

	.widget-row:last-child {
		border-bottom: none;
	}

	.widget-row.odd {
		background-color: var(--secondary-soft-background);
	}

	.widget-row.even {
		background-color: var(--secondary-background);
	}

	.widget-row.selected {
		background-color: var(--primary-foreground);
		color: var(--primary-background);
	}

	.widget-name {
		font-size: 2vh;
		font-weight: 500;
	}

	.back-button {
		margin-top: 2vh;
	}
</style>

{#if showPositionDialog}
	<SettingsFooterPosition {areaID} onBack={closePositionDialog} />
{:else}
	<div class="footer-settings">
		<div class="content">
			<div class="widgets-table">
				<div class="widget-row odd" class:selected={active && selectedIndex === 0} bind:this={rowElements[0]}>
					<span class="widget-name">{$t.settings?.footerVisible}</span>
					<Switch checked={$footerVisible} />
				</div>
			</div>
			<Button label="{$t.settings?.footerPosition}: {$t.settings?.footerPositions?.[$footerPosition]}" selected={active && selectedIndex === 1} onConfirm={openPositionDialog} bind:this={rowElements[1]} />
			<div class="widgets-table">
				{#each footerWidgets as widget, index}
					<div class="widget-row" class:odd={index % 2 === 0} class:even={index % 2 === 1} class:selected={active && selectedIndex === index + 2} bind:this={rowElements[index + 2]}>
						<span class="widget-name">{$t.settings?.footerWidgets?.[widget]}</span>
						<Switch checked={$footerWidgetVisibility[widget]} />
					</div>
				{/each}
			</div>
			<div class="back-button" bind:this={rowElements[totalItems - 1]}>
				<Button label={$t.common?.back} selected={active && selectedIndex === totalItems - 1} onConfirm={onBack} />
			</div>
		</div>
	</div>
{/if}
