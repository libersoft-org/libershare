<script lang="ts">
	import { removeNotification, type NotificationType } from '../../scripts/notifications.ts';
	import Icon from '../Icon/Icon.svelte';
	interface Props {
		id: number;
		text: string;
		type?: NotificationType;
	}
	let { id, text, type = 'info' }: Props = $props();
</script>

<style>
	.notification {
		pointer-events: auto;
		display: flex;
		align-items: flex-start;
		gap: 1.5vh;
		padding: 1.4vh;
		background: var(--secondary-background);
		border: 0.3vh solid var(--secondary-softer-background);
		border-radius: 1vh;
		color: var(--secondary-foreground);
		font-size: 1.8vh;
		box-shadow: 0 0.5vh 2vh rgba(0, 0, 0, 0.4);
		animation: slide-in 0.3s ease-out;
		max-width: min(50vh, calc(100vw - 4vh));
		box-sizing: border-box;
	}

	.notification:hover {
		border-color: var(--primary-foreground);
	}

	.notification.success {
		border-color: color-mix(in srgb, var(--color-success) 40%, transparent);
		background: linear-gradient(135deg, var(--secondary-background) 0%, color-mix(in srgb, var(--color-success) 15%, var(--secondary-background)) 100%);
	}
	.notification.success:hover {
		border-color: var(--color-success);
	}

	.notification.error {
		border-color: color-mix(in srgb, var(--color-error) 40%, transparent);
		background: linear-gradient(135deg, var(--secondary-background) 0%, color-mix(in srgb, var(--color-error) 15%, var(--secondary-background)) 100%);
	}
	.notification.error:hover {
		border-color: var(--color-error);
	}

	.notification.warning {
		border-color: color-mix(in srgb, var(--color-warning) 40%, transparent);
		background: linear-gradient(135deg, var(--secondary-background) 0%, color-mix(in srgb, var(--color-warning) 15%, var(--secondary-background)) 100%);
	}
	.notification.warning:hover {
		border-color: var(--color-warning);
	}

	.type-indicator {
		width: 0.8vh;
		border-radius: 0.4vh;
		flex-shrink: 0;
		align-self: stretch;
	}
	.type-indicator.info {
		background: var(--primary-foreground);
	}
	.type-indicator.success {
		background: var(--color-success);
	}
	.type-indicator.error {
		background: var(--color-error);
	}
	.type-indicator.warning {
		background: var(--color-warning);
	}

	.text {
		flex: 1;
	}

	.close {
		background: none;
		border: none;
		color: var(--secondary-foreground);
		font-size: 2vh;
		cursor: none;
		padding: 0;
	}

	@keyframes slide-in {
		from {
			transform: translateX(100%);
		}
		to {
			transform: translateX(0);
		}
	}
</style>

<div class="notification {type}">
	<div class="type-indicator {type}"></div>
	<span class="text">{text}</span>
	<button class="close" onclick={() => removeNotification(id)}><Icon img="/img/cross.svg" size="1.8vh" padding="0" colorVariable="--secondary-foreground" /></button>
</div>
