<script lang="ts">
	interface Props {
		value: string;
		label: string;
	}
	let { value, label }: Props = $props();
</script>

<option {value}>{label}</option>
