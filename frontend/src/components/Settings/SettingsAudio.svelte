<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { audioEnabled, setAudioEnabled } from '../../scripts/settings.ts';
	import MenuTitle from '../Menu/MenuTitle.svelte';
	import MenuBar from '../Menu/MenuBar.svelte';
	import ButtonsGroup from '../Buttons/ButtonsGroup.svelte';
	import Button from '../Buttons/Button.svelte';
	interface Props {
		areaID: string;
		onBack?: () => void;
	}
	let { areaID, onBack }: Props = $props();

	function setEnabled(enabled: boolean) {
		setAudioEnabled(enabled);
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
	<MenuTitle title={$t.settings?.audio} />
	<MenuBar>
		<ButtonsGroup {areaID} {onBack} initialIndex={$audioEnabled ? 0 : 1}>
			<Button label={$t.common?.yes} onConfirm={() => setEnabled(true)} />
			<Button label={$t.common?.no} onConfirm={() => setEnabled(false)} />
			<Button label={$t.common?.back} onConfirm={onBack} />
		</ButtonsGroup>
	</MenuBar>
</div>
