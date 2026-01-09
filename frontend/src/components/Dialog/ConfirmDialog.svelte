<script lang="ts">
	import { onMount } from 'svelte';
	import Dialog from './Dialog.svelte';
	import ButtonsStatic from '../Buttons/ButtonsStatic.svelte';
	import Button from '../Buttons/Button.svelte';
	import { registerArea, activateArea } from '../../scripts/areas.ts';
	interface Props {
		title: string;
		message: string;
		confirmLabel?: string;
		cancelLabel?: string;
		defaultButton?: 'confirm' | 'cancel';
		onConfirm: () => void;
		onBack: () => void;
	}
	let { title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', defaultButton = 'confirm', onConfirm, onBack }: Props = $props();
	let selectedButton = $state<'confirm' | 'cancel'>(defaultButton);
	let isPressed = $state(false);

	function navigateLeft() {
		selectedButton = 'cancel';
	}

	function navigateRight() {
		selectedButton = 'confirm';
	}

	function handleConfirmDown() {
		isPressed = true;
	}

	function handleConfirmUp() {
		isPressed = false;
		if (selectedButton === 'confirm') onConfirm();
		else onBack();
	}

	function handleConfirmCancel() {
		isPressed = false;
	}

	onMount(() => {
		const unregister = registerArea('confirm-dialog', { x: 1, y: 1 }, {
			left: navigateLeft,
			right: navigateRight,
			confirmDown: handleConfirmDown,
			confirmUp: handleConfirmUp,
			confirmCancel: handleConfirmCancel,
			back: onBack,
		});
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
			<Button label={cancelLabel} selected={selectedButton === 'cancel'} pressed={selectedButton === 'cancel' && isPressed} onConfirm={onBack} />
			<Button label={confirmLabel} selected={selectedButton === 'confirm'} pressed={selectedButton === 'confirm' && isPressed} {onConfirm} />
		</ButtonsStatic>
	</div>
</Dialog>
