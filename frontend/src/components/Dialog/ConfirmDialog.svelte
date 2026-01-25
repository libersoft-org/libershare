<script lang="ts">
	import { onMount } from 'svelte';
	import Dialog from './Dialog.svelte';
	import ButtonsStatic from '../Buttons/ButtonsStatic.svelte';
	import Button from '../Buttons/Button.svelte';
	import { useArea, activateArea } from '../../scripts/areas.ts';
	import type { Position } from '../../scripts/navigationLayout.ts';
	interface Props {
		title: string;
		message: string;
		confirmLabel?: string;
		cancelLabel?: string;
		confirmIcon?: string;
		cancelIcon?: string;
		defaultButton?: 'confirm' | 'cancel';
		position: Position;
		onConfirm: () => void;
		onBack: () => void;
	}
	let { title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', confirmIcon, cancelIcon, defaultButton = 'confirm', position, onConfirm, onBack }: Props = $props();
	let selectedButton = $state<'confirm' | 'cancel'>(defaultButton);
	let isPressed = $state(false);

	onMount(() => {
		// Modal dialog - register with position and handlers
		const unregister = useArea(
			'confirm-dialog',
			{
				up: () => true, // Block navigation outside dialog
				down: () => true, // Block navigation outside dialog
				left: () => {
					selectedButton = 'cancel';
					return true;
				},
				right: () => {
					selectedButton = 'confirm';
					return true;
				},
				confirmDown: () => {
					isPressed = true;
				},
				confirmUp: () => {
					isPressed = false;
					if (selectedButton === 'confirm') onConfirm();
					else onBack();
				},
				confirmCancel: () => {
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
	}
</style>

<Dialog {title}>
	<div class="confirm">
		<div class="message">{message}</div>
		<ButtonsStatic>
			<Button icon={cancelIcon} label={cancelLabel} selected={selectedButton === 'cancel'} pressed={selectedButton === 'cancel' && isPressed} onConfirm={onBack} />
			<Button icon={confirmIcon} label={confirmLabel} selected={selectedButton === 'confirm'} pressed={selectedButton === 'confirm' && isPressed} {onConfirm} />
		</ButtonsStatic>
	</div>
</Dialog>
