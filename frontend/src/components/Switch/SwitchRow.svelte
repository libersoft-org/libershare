<script lang="ts">
	import Row from '../Row/Row.svelte';
	import Switch from './Switch.svelte';
	interface Props {
		label: string;
		checked: boolean;
		selected?: boolean;
		disabled?: boolean;
		onToggle?: () => void;
		onConfirm?: () => void;
	}
	let { label, checked, selected = false, disabled = false }: Props = $props();
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

<Row {selected} {disabled}>
	<div class="switch-row">
		<span class="label">{label}</span>
		<Switch {checked} {selected} {disabled} />
	</div>
</Row>
