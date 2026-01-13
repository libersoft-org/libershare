<script lang="ts">
	interface Props {
		label?: string;
	}
	let { label = '' }: Props = $props();
</script>

<style>
	.badge {
		display: inline-block;
		text-align: center;
		padding: 0.3vh 0.8vh;
		border: 0.2vh solid var(--disabled-foreground);
		border-radius: 0.5vh;
		background-color: var(--disabled-background);
		color: var(--disabled-foreground);
		font-size: inherit;
		white-space: nowrap;
	}
</style>

<div class="badge">{label}</div>
