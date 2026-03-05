<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { type NavAreaController, type NavPos, navItem } from '../../scripts/navArea.svelte.ts';
	interface Props {
		value?: string | undefined;
		label?: string | undefined;
		placeholder?: string | undefined;
		selected?: boolean | undefined;
		type?: 'text' | 'password' | 'email' | 'number' | 'url' | undefined;
		min?: number | undefined;
		max?: number | undefined;
		multiline?: boolean | undefined;
		rows?: number | undefined;
		fontSize?: string | undefined;
		fontFamily?: string | undefined;
		padding?: string | undefined;
		flex?: boolean | undefined;
		readonly?: boolean | undefined;
		disabled?: boolean | undefined;
		onchange?: ((value: string) => void) | undefined;
		/** Position in NavArea grid [x, y]. When set, registers with parent NavArea. */
		position?: NavPos | undefined;
		el?: HTMLElement | undefined;
	}
	let { value = $bindable(''), label, placeholder, selected = false, type = 'text', min, max, multiline = false, rows = 3, fontSize = '2.5vh', fontFamily, padding = '1.5vh 2vh', flex = false, readonly = false, disabled = false, onchange, position, el = $bindable() }: Props = $props();
	const navArea = getContext<NavAreaController | undefined>('navArea');
	let inputElement: HTMLInputElement | HTMLTextAreaElement | undefined = $state();
	let isSelected = $derived(navArea && position ? navArea.isSelected(position) : selected);

	export function focus(): void {
		inputElement?.focus();
	}

	export function blur(): void {
		inputElement?.blur();
	}

	export function getInputElement(): HTMLInputElement | HTMLTextAreaElement | undefined {
		return inputElement;
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			inputElement?.blur();
		}
	}

	function handleInput(event: Event): void {
		const target = event.target as HTMLInputElement | HTMLTextAreaElement;
		value = target.value;
		onchange?.(value);
	}

	onMount(() => {
		if (navArea && position)
			return navArea.register(navItem(() => position!, () => el, () => focus()));
		return undefined;
	});
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
		font-family: var(--input-font-family, inherit);
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

<div bind:this={el} class="input-field" class:selected={isSelected} class:flex class:disabled style="--input-font-size: {fontSize}; --input-padding: {padding};{fontFamily ? ` --input-font-family: ${fontFamily};` : ''}">
	{#if label}
		<div class="label">{label}:</div>
	{/if}
	{#if multiline}
		<textarea {placeholder} {rows} {readonly} {disabled} bind:value bind:this={inputElement} onkeydown={handleKeydown} oninput={handleInput}></textarea>
	{:else}
		<input {type} {placeholder} {readonly} {disabled} {min} {max} bind:value bind:this={inputElement} onkeydown={handleKeydown} oninput={handleInput} />
	{/if}
</div>
