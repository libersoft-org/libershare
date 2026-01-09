<script lang="ts">
	import { onMount } from 'svelte';
	import Dialog from './Dialog.svelte';
	import ButtonsStatic from '../Buttons/ButtonsStatic.svelte';
	import Button from '../Buttons/Button.svelte';
	import { useArea, setAreaPosition, removeArea, activateArea } from '../../scripts/areas.ts';
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

	onMount(() => {
		// Modal dialog - add to layout and register handlers
		setAreaPosition('confirm-dialog', { x: 1, y: 1 });
		const unregister = useArea('confirm-dialog', {
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
		});
		activateArea('confirm-dialog');
		return () => {
			unregister();
			removeArea('confirm-dialog');
		};
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
