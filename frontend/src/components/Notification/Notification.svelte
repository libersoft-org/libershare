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
		border-color: #2a5a2a;
		background: linear-gradient(135deg, var(--secondary-background) 0%, #1a2e1a 100%);
	}
	.notification.success:hover { border-color: #4caf50; }

	.notification.error {
		border-color: #5a2a2a;
		background: linear-gradient(135deg, var(--secondary-background) 0%, #2e1a1a 100%);
	}
	.notification.error:hover { border-color: #f44336; }

	.notification.warning {
		border-color: #5a4a2a;
		background: linear-gradient(135deg, var(--secondary-background) 0%, #2e261a 100%);
	}
	.notification.warning:hover { border-color: #ff9800; }

	.type-indicator {
		width: 0.8vh;
		min-height: 100%;
		border-radius: 0.4vh;
		flex-shrink: 0;
		align-self: stretch;
	}
	.type-indicator.info { background: var(--primary-foreground); }
	.type-indicator.success { background: #4caf50; }
	.type-indicator.error { background: #f44336; }
	.type-indicator.warning { background: #ff9800; }

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
