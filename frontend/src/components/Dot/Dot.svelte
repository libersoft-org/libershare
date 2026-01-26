<script lang="ts">
	import type { DotStatus } from '../../scripts/dot.ts';
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
		background-color: var(--dot-color);
		box-shadow: 0 0 0.8vh 0.2vh var(--dot-color);
	}

	.dot.success {
		--dot-color: var(--color-success);
	}

	.dot.warning {
		--dot-color: var(--color-warning);
	}

	.dot.error {
		--dot-color: var(--color-error);
	}

	.dot.disabled {
		--dot-color: var(--disabled-foreground);
	}
</style>

<div class="dot {status}"></div>
