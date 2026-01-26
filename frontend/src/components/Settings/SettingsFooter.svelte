<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../../scripts/language.ts';
	import { navigateTo } from '../../scripts/navigation.ts';
	import { footerVisible, setFooterVisible, footerPosition, footerWidgetVisibility, setFooterWidgetVisibility } from '../../scripts/settings.ts';
	import { scrollToElement } from '../../scripts/utils.ts';
	import { footerWidgets, type FooterWidget } from '../../scripts/footerWidgets.ts';
	import { useArea, activeArea, activateArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import Button from '../Buttons/Button.svelte';
	import Switch from '../Switch/Switch.svelte';
	import Table from '../Table/Table.svelte';
	import TableRow from '../Table/TableRow.svelte';
	import TableCell from '../Table/TableCell.svelte';

	function getWidgetLabel(widget: FooterWidget): string {
		const labels: Record<FooterWidget, string> = {
			version: $t.common?.version,
			download: $t.settings?.footerWidgets?.downloads,
			upload: $t.settings?.footerWidgets?.uploads,
			cpu: $t.settings?.footerWidgets?.cpu,
			ram: $t.settings?.footerWidgets?.ram,
			storage: $t.settings?.footerWidgets?.storage,
			backendStatus: $t.settings?.footerWidgets?.backendStatus,
			lishStatus: $t.settings?.footerWidgets?.lishStatus,
			connection: $t.settings?.footerWidgets?.connection,
			volume: $t.settings?.footerWidgets?.volume,
			clock: $t.settings?.footerWidgets?.clock,
		};
		return labels[widget] ?? widget;
	}
	interface Props {
		areaID: string;
		position?: Position;
		onBack?: () => void;
	}
	let { areaID, position = CONTENT_POSITIONS.main, onBack }: Props = $props();
	let active = $derived($activeArea === areaID);
	let selectedIndex = $state(0);
	// 0 = visibility switch, 1 = position button, 2+ = widget rows, last = back button
	const totalItems = 3 + footerWidgets.length;
	let rowElements: HTMLElement[] = $state([]);

	function openPositionDialog() {
		navigateTo('footer-position');
	}

	onMount(() => {
		const unregister = useArea(
			areaID,
			{
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
				left: () => false,
				right: () => false,
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
			},
			position
		);
		activateArea(areaID);
		return unregister;
	});

	const scrollToSelected = () => scrollToElement(rowElements, selectedIndex);
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

	.inner {
		width: 1200px;
		max-width: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2vh;
		font-size: 2vh;
	}

	.back {
		margin-top: 2vh;
	}
</style>

<div class="footer">
	<div class="content">
		<div class="inner">
			<Table columns="1fr 10vw" columnsMobile="1fr auto">
				<div bind:this={rowElements[0]}>
					<TableRow selected={active && selectedIndex === 0} odd>
						<TableCell>{$t.settings?.footerVisible}</TableCell>
						<TableCell align="right"><Switch checked={$footerVisible} /></TableCell>
					</TableRow>
				</div>
			</Table>
			<div bind:this={rowElements[1]}>
				<Button label="{$t.settings?.footerPosition}: {$t.settings?.footerPositions?.[$footerPosition]}" selected={active && selectedIndex === 1} onConfirm={openPositionDialog} />
			</div>
			<Table columns="1fr 10vw" columnsMobile="1fr auto">
				{#each footerWidgets as widget, index}
					<div bind:this={rowElements[index + 2]}>
						<TableRow selected={active && selectedIndex === index + 2} odd={index % 2 === 0}>
							<TableCell>{getWidgetLabel(widget)}</TableCell>
							<TableCell align="right"><Switch checked={$footerWidgetVisibility[widget]} /></TableCell>
						</TableRow>
					</div>
				{/each}
			</Table>
			<div class="back" bind:this={rowElements[totalItems - 1]}>
				<Button icon="/img/back.svg" label={$t.common?.back} selected={active && selectedIndex === totalItems - 1} onConfirm={onBack} />
			</div>
		</div>
	</div>
</div>
