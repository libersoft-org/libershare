<script lang="ts">
	import Row from '../Row/Row.svelte';
	import Switch from './Switch.svelte';
	interface Props {
		label: string;
		checked: boolean;
		selected?: boolean;
		onToggle?: () => void;
		onConfirm?: () => void;
	}
	let { label, checked, selected = false, onToggle, onConfirm }: Props = $props();
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
		color: var(--secondary-foreground);
	}
</style>

<Row {selected}>
	<div class="switch-row">
		<span class="label">{label}</span>
		<Switch {checked} {selected} {onToggle} {onConfirm} />
	</div>
</Row>
