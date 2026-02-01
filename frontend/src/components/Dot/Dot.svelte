<script lang="ts">
	import { type DotStatus } from '../../scripts/dot.ts';
	interface Props {
		status?: DotStatus;
		animate?: boolean;
		glow?: boolean;
		size?: string;
	}
	const { status = 'error', animate = false, glow = false, size = '1.2vh' }: Props = $props();
</script>

<style>
	.dot {
		border-radius: 50%;
		background-color: var(--dot-color);
	}

	.dot.animate {
		animation: glow 1s ease-in-out infinite alternate;
	}

	@keyframes glow {
		from {
			box-shadow: 0 0 1vh 0.2vh var(--dot-color);
		}
		to {
			box-shadow: none;
		}
	}

	.dot.glow {
		box-shadow: 0 0 1vh 0.2vh var(--dot-color);
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

<div class="dot {status}" class:animate class:glow style="width: {size}; height: {size}; min-width: {size}; min-height: {size};"></div>
