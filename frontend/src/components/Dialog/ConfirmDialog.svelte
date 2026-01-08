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
		const unregister = registerArea('confirm-dialog', {
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
	.title {
		font-size: 4vh;
		font-weight: bold;
		text-align: center;
		color: #fd1;
	}

	.message {
		font-size: 3vh;
		opacity: 0.8;
		text-align: center;
	}
</style>

<Dialog>
	<div class="title">{title}</div>
	<div class="message">{message}</div>
	<ButtonsStatic>
		<Button label={cancelLabel} selected={selectedButton === 'cancel'} pressed={selectedButton === 'cancel' && isPressed} onConfirm={onBack} />
		<Button label={confirmLabel} selected={selectedButton === 'confirm'} pressed={selectedButton === 'confirm' && isPressed} {onConfirm} />
	</ButtonsStatic>
</Dialog>
