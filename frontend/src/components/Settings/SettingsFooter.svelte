<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { footerVisible, setFooterVisible, footerPosition, footerWidgets, footerWidgetVisibility, setFooterWidgetVisibility, type FooterWidget } from '../../scripts/settings.ts';
	import { useArea, activeArea } from '../../scripts/areas.ts';
	import ButtonsGroup from '../Buttons/ButtonsGroup.svelte';
	import Button from '../Buttons/Button.svelte';
	import Dialog from '../Dialog/Dialog.svelte';
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

	// 0 = visibility button, 1 = position button, 2+ = widget rows
	const totalItems = 2 + footerWidgets.length;

	function registerHandlers() {
		return useArea(areaID, {
			up: () => {
				if (selectedIndex > 0) {
					selectedIndex--;
					return true;
				}
				return false;
			},
			down: () => {
				if (selectedIndex < totalItems - 1) {
					selectedIndex++;
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
				} else if (selectedIndex > 1) {
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
				} else if (selectedIndex > 1) {
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
					showPositionDialog = true;
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

	function closePositionDialog() {
		showPositionDialog = false;
	}
</script>

<style>
	.footer-settings {
		display: flex;
		flex-direction: column;
		gap: 2vh;
		padding: 2vh;
		min-width: 50vw;
	}

	.position-button {
		display: flex;
		justify-content: center;
	}

	.position-button :global(.button) {
		min-width: 30vw;
	}

	.widgets-table {
		display: flex;
		flex-direction: column;
		border: 0.2vh solid var(--secondary-softer-background);
		border-radius: 1vh;
		overflow: hidden;
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
</style>

{#if showPositionDialog}
	<SettingsFooterPosition {areaID} onBack={closePositionDialog} />
{:else}
	<Dialog title={$t.settings?.footer}>
		<div class="footer-settings">
			<div class="widgets-table">
				<div
					class="widget-row odd"
					class:selected={active && selectedIndex === 0}
				>
					<span class="widget-name">{$t.settings?.footerVisible}</span>
					<Switch checked={$footerVisible} />
				</div>
			</div>
			<div class="position-button">
				<Button
					label="{$t.settings?.footerPosition}: {$t.settings?.footerPositions?.[$footerPosition]}"
					selected={active && selectedIndex === 1}
					onConfirm={() => (showPositionDialog = true)}
				/>
			</div>
			<div class="widgets-table">
				{#each footerWidgets as widget, index}
					<div
						class="widget-row"
						class:odd={index % 2 === 0}
						class:even={index % 2 === 1}
						class:selected={active && selectedIndex === index + 2}
					>
						<span class="widget-name">{$t.settings?.footerWidgets?.[widget]}</span>
						<Switch checked={$footerWidgetVisibility[widget]} />
					</div>
				{/each}
			</div>
		</div>
	</Dialog>
{/if}
