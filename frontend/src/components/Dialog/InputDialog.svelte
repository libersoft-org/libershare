<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { untrack } from 'svelte';
	import { useArea, activateArea } from '../../scripts/areas.ts';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import Dialog from './Dialog.svelte';
	import ButtonsStatic from '../Buttons/ButtonsStatic.svelte';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';
	import Alert from '../Alert/Alert.svelte';
	interface Props {
		title: string;
		label?: string;
		placeholder?: string;
		initialValue?: string;
		confirmLabel?: string;
		cancelLabel?: string;
		confirmIcon?: string;
		cancelIcon?: string;
		error?: string;
		position: Position;
		onConfirm: (value: string) => void;
		onBack: () => void;
	}
	let { title, label, placeholder, initialValue = '', confirmLabel = 'OK', cancelLabel = 'Cancel', confirmIcon, cancelIcon, error, position, onConfirm, onBack }: Props = $props();
	let value = $state(untrack(() => initialValue));
	let selectedElement = $state<'input' | 'cancel' | 'confirm'>('input');
	let isPressed = $state(false);
	let inputRef: ReturnType<typeof Input> | undefined = $state();

	function handleConfirm() {
		onConfirm(value.trim());
	}

	onMount(() => {
		const unregister = useArea(
			'input-dialog',
			{
				up: () => {
					if (selectedElement === 'cancel' || selectedElement === 'confirm') {
						selectedElement = 'input';
						tick().then(() => inputRef?.focus());
						return true;
					}
					return true; // Block navigation outside dialog
				},
				down: () => {
					if (selectedElement === 'input') {
						inputRef?.blur();
						selectedElement = 'cancel';
						return true;
					}
					return true; // Block navigation outside dialog
				},
				left: () => {
					if (selectedElement === 'cancel') {
						selectedElement = 'confirm';
						return true;
					}
					return true;
				},
				right: () => {
					if (selectedElement === 'confirm') {
						selectedElement = 'cancel';
						return true;
					}
					return true;
				},
				confirmDown: () => {
					if (selectedElement !== 'input') isPressed = true;
				},
				confirmUp: () => {
					isPressed = false;
					if (selectedElement === 'input') {
						// Focus input for editing
						inputRef?.focus();
					} else if (selectedElement === 'confirm') handleConfirm();
					else onBack();
				},
				confirmCancel: () => {
					isPressed = false;
				},
				back: onBack,
			},
			position
		);
		activateArea('input-dialog');
		// Focus input on mount
		tick().then(() => inputRef?.focus());
		return unregister;
	});
</script>

<style>
	.input-dialog {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 3vh;
		min-width: 40vh;
	}
</style>

<Dialog {title}>
	<div class="input-dialog">
		<Input bind:this={inputRef} bind:value {label} {placeholder} selected={selectedElement === 'input'} />
		{#if error}
			<Alert type="error" message={error} />
		{/if}
		<ButtonsStatic>
			<Button icon={confirmIcon} label={confirmLabel} selected={selectedElement === 'confirm'} pressed={selectedElement === 'confirm' && isPressed} onConfirm={handleConfirm} />
			<Button icon={cancelIcon} label={cancelLabel} selected={selectedElement === 'cancel'} pressed={selectedElement === 'cancel' && isPressed} onConfirm={onBack} />
		</ButtonsStatic>
	</div>
</Dialog>
