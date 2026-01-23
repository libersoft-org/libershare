<script lang="ts">
	interface Props {
		value?: string;
		label?: string;
		placeholder?: string;
		selected?: boolean;
		type?: 'text' | 'password' | 'email' | 'number' | 'url';
		multiline?: boolean;
		rows?: number;
		fontSize?: string;
		padding?: string;
		flex?: boolean;
		readonly?: boolean;
		disabled?: boolean;
		onchange?: (value: string) => void;
	}

	let { value = $bindable(''), label, placeholder, selected = false, type = 'text', multiline = false, rows = 3, fontSize = '2.5vh', padding = '1.5vh 2vh', flex = false, readonly = false, disabled = false, onchange }: Props = $props();
	let inputElement: HTMLInputElement | HTMLTextAreaElement | undefined = $state();

	export function focus() {
		inputElement?.focus();
	}

	export function blur() {
		inputElement?.blur();
	}

	export function getInputElement() {
		return inputElement;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			inputElement?.blur();
		}
	}

	function handleInput(event: Event) {
		const target = event.target as HTMLInputElement | HTMLTextAreaElement;
		value = target.value;
		onchange?.(value);
	}
</script>

<style>
	.input-field {
		display: flex;
		flex-direction: column;
		gap: 0.5vh;
	}

	.label {
		font-size: 2vh;
		color: var(--disabled-foreground);
	}

	input,
	textarea {
		font-size: var(--input-font-size);
		padding: var(--input-padding);
		border: 0.3vh solid var(--secondary-softer-background);
		border-radius: 1vh;
		background-color: var(--secondary-background);
		color: var(--secondary-foreground);
		outline: none;
		transition: border-color 0.2s;
	}

	textarea {
		resize: vertical;
		font-family: inherit;
	}

	input:focus,
	textarea:focus {
		border-color: var(--primary-foreground);
	}

	.input-field.selected input,
	.input-field.selected textarea {
		border-color: var(--primary-foreground);
	}

	.input-field.flex {
		flex: 1;
	}

	.input-field.disabled input,
	.input-field.disabled textarea {
		background-color: var(--disabled-foreground);
		color: var(--disabled-background);
		border-color: var(--disabled-background);
		cursor: not-allowed;
	}
</style>

<div class="input-field" class:selected class:flex class:disabled style="--input-font-size: {fontSize}; --input-padding: {padding};">
	{#if label}
		<div class="label">{label}:</div>
	{/if}
	{#if multiline}
		<textarea {placeholder} {rows} {readonly} {disabled} bind:value bind:this={inputElement} onkeydown={handleKeydown} oninput={handleInput}></textarea>
	{:else}
		<input {type} {placeholder} {readonly} {disabled} bind:value bind:this={inputElement} onkeydown={handleKeydown} oninput={handleInput} />
	{/if}
</div>
