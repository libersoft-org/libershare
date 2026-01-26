<script lang="ts">
	import Icon from '../Icon/Icon.svelte';
	interface Props {
		type?: 'error' | 'warning' | 'info';
		message?: string;
	}
	let { type = 'info', message = '' }: Props = $props();
	
	const iconMap = {
		error: '/img/error.svg',
		warning: '/img/warning.svg',
		info: '/img/info.svg'
	};
	
	const colorMap = {
		error: '--color-error',
		warning: '--color-warning',
		info: '--color-success'
	};
</script>

<style>
	.alert {
		display: flex;
		align-items: center;
		padding: 1.5vh 2vh;
		border: 0.3vh solid;
		border-radius: 1vh;
		font-size: 2vh;
		gap: 1vh;
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
		<Icon img={iconMap[type]} size="2.5vh" padding="0" colorVariable={colorMap[type]} />
		{message}
	</div>
{/if}
