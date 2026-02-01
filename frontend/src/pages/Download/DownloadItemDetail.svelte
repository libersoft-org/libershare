<script lang="ts">
	import { type Snippet } from 'svelte';
	interface Props {
		label: string;
		children: Snippet;
	}
	let { label, children }: Props = $props();
</script>

<style>
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.5vh 0;
		border-bottom: 0.2vh solid var(--secondary-softer-background);
	}

	.label {
		color: var(--disabled-foreground);
	}

	.value {
		font-weight: bold;
	}
</style>

<div class="row">
	<span class="label">{label}</span>
	<span class="value">{@render children()}</span>
</div>
