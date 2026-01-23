<script lang="ts">
	export type DotStatus = 'success' | 'warning' | 'error';
	interface Props {
		status?: DotStatus;
	}
	const { status = 'error' }: Props = $props();
</script>

<style>
	.dot {
		min-width: 1.2vh;
		min-height: 1.2vh;
		width: 1.2vh;
		height: 1.2vh;
		border-radius: 50%;
		border: 0.2vh solid var(--secondary-foreground);
	}

	.dot.success {
		background-color: var(--color-success);
	}

	.dot.warning {
		background-color: var(--color-warning);
	}

	.dot.error {
		background-color: var(--color-error);
	}
</style>

<div class="dot {status}"></div>
