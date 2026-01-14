<script lang="ts">
	interface Props {
		value?: string;
		label?: string;
		placeholder?: string;
		selected?: boolean;
		type?: 'text' | 'password' | 'email' | 'number' | 'url';
		onchange?: (value: string) => void;
	}

	let { value = $bindable(''), label, placeholder, selected = false, type = 'text', onchange }: Props = $props();
	let inputElement: HTMLInputElement;

	export function focus() {
		inputElement?.focus();
	}

	export function blur() {
		inputElement?.blur();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			inputElement?.blur();
		}
	}

	function handleInput(event: Event) {
		const target = event.target as HTMLInputElement;
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

	input {
		font-size: 2.5vh;
		padding: 1.5vh 2vh;
		border: 0.3vh solid var(--secondary-softer-background);
		border-radius: 1vh;
		background-color: var(--secondary-background);
		color: var(--secondary-foreground);
		outline: none;
		transition: border-color 0.2s;
	}

	input:focus {
		border-color: var(--primary-foreground);
	}

	.input-field.selected input {
		border-color: var(--primary-foreground);
	}
</style>

<div class="input-field" class:selected>
	{#if label}
		<div class="label">{label}</div>
	{/if}
	<input {type} {placeholder} bind:value bind:this={inputElement} onkeydown={handleKeydown} oninput={handleInput} />
</div>
