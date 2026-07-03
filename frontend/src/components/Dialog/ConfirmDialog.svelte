<script lang="ts">
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import Dialog from './Dialog.svelte';
	import ButtonBar from '../Buttons/ButtonBar.svelte';
	import Button from '../Buttons/Button.svelte';
	interface Props {
		title: string;
		message: string;
		confirmLabel?: string | undefined;
		cancelLabel?: string | undefined;
		confirmIcon?: string | undefined;
		cancelIcon?: string | undefined;
		defaultButton?: 'confirm' | 'cancel' | undefined;
		position: Position;
		onConfirm: () => void;
		onBack: () => void;
	}
	let { title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', confirmIcon, cancelIcon, defaultButton = 'cancel', position, onConfirm, onBack }: Props = $props();

	createNavArea(() => ({ areaID: 'confirm-dialog', position, activate: true, trap: true, onBack, initialPosition: defaultButton === 'confirm' ? [0, 0] : [1, 0] }));
</script>

<style>
	.confirm {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3vh;
	}

	.message {
		font-size: 2vh;
		text-align: center;
		white-space: pre-line;
		line-height: 1.6;
	}
</style>

<Dialog {title}>
	<div class="confirm">
		<div class="message">{message}</div>
		<ButtonBar justify="center" basePosition={[0, 0]}>
			<Button icon={confirmIcon} label={confirmLabel} {onConfirm} />
			<Button icon={cancelIcon} label={cancelLabel} onConfirm={onBack} />
		</ButtonBar>
	</div>
</Dialog>
