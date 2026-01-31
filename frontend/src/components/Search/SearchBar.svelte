<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import Input from '../Input/Input.svelte';
	interface Props {
		value?: string;
		placeholder?: string;
		selected?: boolean;
		onchange?: (value: string) => void;
		onConfirm?: () => void;
	}
	let { value = $bindable(''), placeholder, selected = false, onchange, onConfirm }: Props = $props();
	let searchPlaceholder = $derived(placeholder ?? $t('common.search') + ' ...');
	let inputComponent: Input;
	export function toggleFocus() {
		const inputElement = inputComponent?.getInputElement();
		const isFocused = inputElement && document.activeElement === inputElement;
		if (isFocused) inputComponent?.blur();
		else inputComponent?.focus();
	}
</script>

<style>
	.search {
		padding: 1vh;
		background-color: var(--secondary-background);
		border-bottom: 0.2vh solid var(--secondary-softer-background);
	}
</style>

<div class="search">
	<Input bind:this={inputComponent} bind:value placeholder={searchPlaceholder} {selected} {onchange} fontSize="2vh" padding="1vh 1.5vh" />
</div>
