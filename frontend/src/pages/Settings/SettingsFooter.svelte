<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { navigateTo } from '../../scripts/navigation.ts';
	import { footerVisible, setFooterVisible, footerPosition, footerWidgetVisibility, setFooterWidgetVisibility } from '../../scripts/settings.ts';
	import { footerWidgets, getWidgetLabel } from '../../scripts/footerWidgets.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { CONTENT_POSITIONS } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import ButtonBar from '../../components/Buttons/ButtonBar.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import SwitchRow from '../../components/Switch/SwitchRow.svelte';
	interface Props {
		areaID: string;
		position?: Position | undefined;
		onBack?: (() => void) | undefined;
	}
	let { areaID, position = CONTENT_POSITIONS.main, onBack }: Props = $props();

	function openPositionDialog(): void {
		navigateTo('footer-position');
	}

	createNavArea(() => ({ areaID, position, onBack, activate: true }));
</script>

<style>
	.content {
		height: 100%;
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
		align-items: stretch;
		gap: 2vh;
		font-size: 2vh;
	}
</style>

<div class="content">
	<div class="inner">
		<ButtonBar>
			<Button icon="/img/back.svg" label={$t('common.back')} position={[0, 0]} onConfirm={onBack} />
		</ButtonBar>
		<div
			role="group"
			data-mouse-activate-area={areaID}
		>
			<SwitchRow label={$t('settings.footerVisible')} checked={$footerVisible} position={[0, 1]} onToggle={() => setFooterVisible(!$footerVisible)} />
		</div>
		<ButtonBar justify="center">
			<Button label="{$t('settings.footerPosition')}: {$t('settings.footerPositions.' + $footerPosition)}" position={[0, 2]} onConfirm={openPositionDialog} />
		</ButtonBar>
		{#each footerWidgets as widget, index}
			<div
				role="group"
				data-mouse-activate-area={areaID}
			>
				<SwitchRow label={getWidgetLabel(widget, $t)} checked={$footerWidgetVisibility[widget]} position={[0, index + 3]} onToggle={() => setFooterWidgetVisibility(widget, !$footerWidgetVisibility[widget])} />
			</div>
		{/each}
	</div>
</div>
