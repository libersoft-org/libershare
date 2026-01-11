<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { footerPosition, setFooterPosition, type FooterPosition } from '../../scripts/settings.ts';
	import ButtonsGroup from '../Buttons/ButtonsGroup.svelte';
	import Button from '../Buttons/Button.svelte';
	import Dialog from '../Dialog/Dialog.svelte';
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

<Dialog title={$t.settings?.footerPosition}>
	<ButtonsGroup {areaID} {onBack} {initialIndex}>
		{#each positions as position}
			<Button label={$t.settings?.footerPositions?.[position]} onConfirm={() => selectPosition(position)} />
		{/each}
		<Button label={$t.common?.back} onConfirm={onBack} />
	</ButtonsGroup>
</Dialog>
