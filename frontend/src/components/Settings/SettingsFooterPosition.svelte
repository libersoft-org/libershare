<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { footerPosition, setFooterPosition, type FooterPosition } from '../../scripts/settings.ts';
	import MenuTitle from '../Menu/MenuTitle.svelte';
	import MenuBar from '../Menu/MenuBar.svelte';
	import ButtonsGroup from '../Buttons/ButtonsGroup.svelte';
	import Button from '../Buttons/Button.svelte';
	interface Props {
		areaID: string;
		onBack?: () => void;
	}
	let { areaID, onBack }: Props = $props();
	const positions: FooterPosition[] = ['left', 'center', 'right'];
	let initialIndex = $derived(positions.indexOf($footerPosition));

	function selectPosition(position: FooterPosition) {
		setFooterPosition(position);
		onBack?.();
	}
</script>

<style>
	.settings-page {
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		overflow: hidden;
	}
</style>

<div class="settings-page">
	<MenuTitle title={$t.settings?.footerPosition} />
	<MenuBar>
		<ButtonsGroup {areaID} {onBack} {initialIndex}>
			{#each positions as position}
				<Button label={$t.settings?.footerPositions?.[position]} onConfirm={() => selectPosition(position)} />
			{/each}
			<Button label={$t.common?.back} onConfirm={onBack} />
		</ButtonsGroup>
	</MenuBar>
</div>
