<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { audioEnabled, setAudioEnabled } from '../../scripts/settings.ts';
	import ButtonsGroup from '../Buttons/ButtonsGroup.svelte';
	import Button from '../Buttons/Button.svelte';
	import Dialog from '../Dialog/Dialog.svelte';
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

<Dialog title={$t.settings?.audio}>
	<ButtonsGroup {areaID} {onBack} initialIndex={$audioEnabled ? 0 : 1}>
		<Button label={$t.common?.yes} onConfirm={() => setEnabled(true)} />
		<Button label={$t.common?.no} onConfirm={() => setEnabled(false)} />
		<Button label={$t.common?.back} onConfirm={onBack} />
	</ButtonsGroup>
</Dialog>
