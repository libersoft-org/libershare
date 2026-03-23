<script lang="ts">
	import { removeNotification } from '../../scripts/notifications.ts';
	import Icon from '../Icon/Icon.svelte';
	interface Props {
		id: number;
		text: string;
	}
	let { id, text }: Props = $props();
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

<div class="notification">
	<span class="text">{text}</span>
	<button class="close" onclick={() => removeNotification(id)}><Icon img="/img/cross.svg" size="1.8vh" padding="0" colorVariable="--secondary-foreground" /></button>
</div>
