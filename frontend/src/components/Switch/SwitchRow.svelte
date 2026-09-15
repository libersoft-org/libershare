<script lang="ts">
	import { getContext, onMount, type Snippet } from 'svelte';
	import { play as playSound } from '../../scripts/audio.ts';
	import { type NavAreaController, type NavPos, navItem } from '../../scripts/navArea.svelte.ts';
	import Row from '../Row/Row.svelte';
	import Switch from './Switch.svelte';
	import Icon from '../Icon/Icon.svelte';
	interface Props {
		icon?: string;
		children?: Snippet;
		actions?: Snippet;
		padding?: string | undefined;
		label: string;
		checked: boolean;
		selected?: boolean;
		disabled?: boolean;
		onToggle?: (() => void) | undefined;
		onConfirm?: (() => void) | undefined;
		/** Position in NavArea grid [x, y]. When set, registers with parent NavArea. */
		position?: NavPos | undefined;
		el?: HTMLElement | undefined;
	}
	let { label, checked, icon, children, actions, padding, selected = false, disabled = false, onToggle, onConfirm, position, el = $bindable() }: Props = $props();
	const navArea = getContext<NavAreaController | undefined>('navArea');
	let isSelected = $derived(navArea && position ? navArea.isSelected(position) : selected);

	function confirm(): void {
		if (!disabled) (onToggle ?? onConfirm)?.();
	}

	onMount(() => {
		if (navArea && position) {
			return navArea.register(
				navItem(
					() => position!,
					() => el,
					confirm,
					{ noDelegateMouse: true }
				)
			);
		}
		return undefined;
	});
</script>

<style>
	.switch-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex: 1;
		min-width: 0;
		gap: 1.5vh;
	}

	.summary { flex: 1; min-width: 0; }
	.label { display: block; overflow-wrap: anywhere; }
	.details { margin-top: 0.4vh; }

	.label {
		font-size: 2vh;
	}
</style>

<Row selected={isSelected} {disabled} {padding} bind:el>
	<div
		class="switch-row"
		onclick={() => {
			if (disabled) return;
			playSound('confirm');
			confirm();
		}}
		onkeydown={e => {
			if (e.key === 'Enter') confirm();
		}}
		role="switch"
		aria-checked={checked}
		aria-disabled={disabled}
		aria-label={label}
		tabindex="-1"
	>
		{#if icon}<Icon img={icon} alt="" size="2.8vh" padding="0" colorVariable="--primary-foreground" />{/if}
		<div class="summary">
			<span class="label">{label}</span>
			{#if children}<div class="details">{@render children()}</div>{/if}
		</div>
		<Switch {checked} selected={isSelected} {disabled} />
	</div>
	{#if actions}{@render actions()}{/if}
</Row>
