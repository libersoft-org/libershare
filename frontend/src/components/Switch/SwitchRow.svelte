<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { type NavAreaController, type NavPos, navItem } from '../../scripts/navArea.svelte.ts';
	import Row from '../Row/Row.svelte';
	import Switch from './Switch.svelte';
	interface Props {
		label: string;
		checked: boolean;
		selected?: boolean;
		disabled?: boolean;
		onToggle?: (() => void) | undefined;
		onConfirm?: (() => void) | undefined;
		/** Position in NavArea grid [x, y]. When set, registers with parent NavArea. */
		position?: NavPos | undefined;
		el?: HTMLElement | undefined;
	}
	let { label, checked, selected = false, disabled = false, onToggle, onConfirm, position, el = $bindable() }: Props = $props();
	const navArea = getContext<NavAreaController | undefined>('navArea');
	let isSelected = $derived(navArea && position ? navArea.isSelected(position) : selected);

	onMount(() => {
		if (navArea && position) {
			return navArea.register(
				navItem(
					() => position!,
					() => el,
					onToggle ?? onConfirm
				)
			);
		}
		return undefined;
	});
</script>

<style>
	.switch-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
	}

	.label {
		font-size: 2vh;
	}
</style>

<Row selected={isSelected} {disabled} bind:el>
	<div
		class="switch-row"
		onclick={() => (onToggle ?? onConfirm)?.()}
		onkeydown={e => {
			if (e.key === 'Enter') (onToggle ?? onConfirm)?.();
		}}
		role="switch"
		aria-checked={checked}
		tabindex="-1"
	>
		<span class="label">{label}</span>
		<Switch {checked} selected={isSelected} {disabled} />
	</div>
</Row>
