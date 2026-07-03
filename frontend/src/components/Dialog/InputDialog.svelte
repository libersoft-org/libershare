<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { untrack } from 'svelte';
	import { type Position } from '../../scripts/navigationLayout.ts';
	import { createNavArea } from '../../scripts/navArea.svelte.ts';
	import Dialog from './Dialog.svelte';
	import ButtonBar from '../Buttons/ButtonBar.svelte';
	import Button from '../Buttons/Button.svelte';
	import Input from '../Input/Input.svelte';
	import Alert from '../Alert/Alert.svelte';
	interface Props {
		title: string;
		label?: string | undefined;
		placeholder?: string | undefined;
		initialValue?: string | undefined;
		confirmLabel?: string | undefined;
		cancelLabel?: string | undefined;
		confirmIcon?: string | undefined;
		cancelIcon?: string | undefined;
		error?: string | undefined;
		position: Position;
		onConfirm: (value: string) => void;
		onBack: () => void;
	}
	let { title, label, placeholder, initialValue = '', confirmLabel = 'OK', cancelLabel = 'Cancel', confirmIcon, cancelIcon, error, position, onConfirm, onBack }: Props = $props();
	let value = $state(untrack(() => initialValue));
	let inputRef: ReturnType<typeof Input> | undefined = $state();

	function handleConfirm(): void {
		onConfirm(value.trim());
	}

	createNavArea(() => ({ areaID: 'input-dialog', position, activate: true, trap: true, onBack }));

	onMount(() => {
		tick().then(() => inputRef?.focus());
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
		<Input bind:this={inputRef} bind:value {label} {placeholder} position={[0, 0]} />
		{#if error}
			<Alert type="error" message={error} />
		{/if}
		<ButtonBar justify="center" basePosition={[0, 1]}>
			<Button icon={confirmIcon} label={confirmLabel} onConfirm={handleConfirm} />
			<Button icon={cancelIcon} label={cancelLabel} onConfirm={onBack} />
		</ButtonBar>
	</div>
</Dialog>
