<script lang="ts">
	import { onMount } from 'svelte';
	import { untrack } from 'svelte';
	import { useArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
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
	let selectedButton = $state<'confirm' | 'cancel'>(untrack(() => defaultButton));
	let isPressed = $state(false);

	onMount(() => {
		// Modal dialog - register with position and handlers
		const unregister = useArea(
			'confirm-dialog',
			{
				up() {
					return true;
				}, // Block navigation outside dialog
				down() {
					return true;
				}, // Block navigation outside dialog
				left() {
					selectedButton = 'confirm';
					return true;
				},
				right() {
					selectedButton = 'cancel';
					return true;
				},
				confirmDown() {
					isPressed = true;
				},
				confirmUp() {
					isPressed = false;
					if (selectedButton === 'confirm') onConfirm();
					else onBack();
				},
				confirmCancel() {
					isPressed = false;
				},
				back: onBack,
			},
			position
		);
		activateArea('confirm-dialog');
		return unregister;
	});
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
		<ButtonBar justify="center">
			<Button icon={confirmIcon} label={confirmLabel} selected={selectedButton === 'confirm'} pressed={selectedButton === 'confirm' && isPressed} {onConfirm} />
			<Button icon={cancelIcon} label={cancelLabel} selected={selectedButton === 'cancel'} pressed={selectedButton === 'cancel' && isPressed} onConfirm={onBack} />
		</ButtonBar>
	</div>
</Dialog>
