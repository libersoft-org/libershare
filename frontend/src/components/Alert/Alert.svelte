<script lang="ts">
	interface Props {
		type?: 'error' | 'warning' | 'info';
		message?: string;
	}
	let { type = 'info', message = '' }: Props = $props();
</script>

<style>
	.alert {
		display: flex;
		align-items: center;
		padding: 1.5vh 2vh;
		border: 0.3vh solid;
		border-radius: 1vh;
		font-size: 2vh;
	}

	.alert.error {
		border-color: var(--color-error);
		color: var(--color-error);
	}

	.alert.warning {
		border-color: var(--color-warning);
		color: var(--color-warning);
	}

	.alert.info {
		border-color: var(--color-success);
		color: var(--color-success);
	}
</style>

{#if message}
	<div class="alert {type}">
		{message}
	</div>
{/if}
