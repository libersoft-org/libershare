<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { type NavAreaController, type NavPos } from '../../scripts/navArea.svelte.ts';
	import Row from '../Row/Row.svelte';
	import Switch from './Switch.svelte';
	interface Props {
		label: string;
		checked: boolean;
		selected?: boolean;
		disabled?: boolean;
		onToggle?: () => void;
		onConfirm?: () => void;
		/** Position in NavArea grid [x, y]. When set, registers with parent NavArea. */
		position?: NavPos | undefined;
	}
	let { label, checked, selected = false, disabled = false, onToggle, onConfirm, position }: Props = $props();
	const navArea = getContext<NavAreaController | undefined>('navArea');
	let rowEl = $state<HTMLElement | undefined>(undefined);
	let isSelected = $derived(navArea && position ? navArea.isSelected(position) : selected);

	onMount(() => {
		if (navArea && position) {
			return navArea.register({ pos: position, get el() { return rowEl; }, onConfirm: onToggle ?? onConfirm });
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

<Row selected={isSelected} {disabled} bind:el={rowEl}>
	<div class="switch-row">
		<span class="label">{label}</span>
		<Switch {checked} selected={isSelected} {disabled} />
	</div>
</Row>
