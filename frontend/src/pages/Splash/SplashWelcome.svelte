<script lang="ts">
	import { t } from '../../scripts/language.ts';
	import { productName, productVersion } from '@shared';
	import Spinner from '../../components/Spinner/Spinner.svelte';
	import Input from '../../components/Input/Input.svelte';
	import Button from '../../components/Buttons/Button.svelte';
	import Alert from '../../components/Alert/Alert.svelte';
	import { type BackendConnectionStatus } from '../../scripts/ws-client.ts';
	import { LAYOUT } from '../../scripts/navigationLayout.ts';
	import { createNavArea, type NavPos } from '../../scripts/navArea.svelte.ts';

	const SPLASH_AREA_ID = 'splash';
	const tokenInputPosition: NavPos = [0, 0];
	const connectButtonPosition: NavPos = [1, 0];

	interface Props {
		url: string;
		connectionStatus: BackendConnectionStatus;
		onTokenSubmit: (token: string) => void;
	}
	let { url, connectionStatus, onTokenSubmit }: Props = $props();
	let token = $state('');
	let needsToken = $derived(connectionStatus === 'auth-required' || connectionStatus === 'auth-failed');

	createNavArea(() => ({
		areaID: SPLASH_AREA_ID,
		position: LAYOUT.content,
		activate: true,
	}));

	function getStatusText(): string {
		switch (connectionStatus) {
			case 'auth-required':
			case 'auth-failed':
				return $t('splash.backendTokenRequired');
			case 'disconnected':
				return $t('common.backendDisconnected');
			default:
				return `${$t('splash.connecting')} ...`;
		}
	}

	function submitToken(): void {
		const trimmed = token.trim();
		if (!trimmed) return;
		onTokenSubmit(trimmed);
	}
</script>

<style>
	.splash {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2vh;
		width: 100%;
		height: 100%;
		background-color: var(--secondary-background);
		color: var(--secondary-foreground);
	}

	.title {
		font-size: 5vh;
		font-weight: bold;
		color: var(--primary-foreground);
	}

	.version {
		font-size: 3vh;
		font-weight: bold;
	}

	.status {
		font-size: 3vh;
	}

	.url {
		font-family: var(--font-mono);
		font-size: 2.4vh;
		color: var(--disabled-foreground);
	}

	.token-form {
		display: flex;
		align-items: center;
		gap: 1vh;
		width: min(70vh, 90vw);
	}

	.token-form :global(.input-field) {
		flex: 1;
	}

	.token-alert {
		width: min(70vh, 90vw);
	}

	.token-alert :global(.alert) {
		box-sizing: border-box;
		justify-content: center;
		width: 100%;
	}
</style>

<div class="splash">
	<div class="title">{productName}</div>
	<div class="version">{productVersion}</div>
	{#if !needsToken}
		<Spinner size="10vh" />
	{/if}
	<div class="status">{getStatusText()}</div>
	{#if needsToken}
		<div class="token-form" role="group" data-mouse-activate-area={SPLASH_AREA_ID}>
			<Input bind:value={token} type="password" placeholder={$t('splash.backendToken')} fontSize="2vh" position={tokenInputPosition} />
			<Button icon="/img/check.svg" label={$t('common.connect')} padding="1.5vh 2vh" fontSize="2vh" iconSize="2vh" width="auto" position={connectButtonPosition} onConfirm={submitToken} />
		</div>
		{#if connectionStatus === 'auth-failed'}
			<div class="token-alert">
				<Alert type="error" message={$t('splash.backendTokenInvalid')} />
			</div>
		{/if}
	{/if}
	<div class="url">{url}</div>
</div>
