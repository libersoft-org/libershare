<script lang="ts">
	/**
	 * A select whose list is searchable, for catalogues too long to scroll.
	 *
	 * A native `<select>` holding 450 time zones is a wall of text: it cannot be
	 * filtered, and the only way to reach a zone is to scroll to it or to guess the
	 * first letters fast enough for the browser's own type-ahead. This keeps the
	 * behaviour of a select (one value, chosen from a fixed list) and adds the two
	 * things that list needs — live filtering as you type, and a click that always
	 * opens the list again.
	 *
	 * The text field is never a free-text value: what it holds while open is the
	 * QUERY, and closing without picking puts the selected value back. So nothing
	 * outside this component ever sees a half-typed zone name.
	 */
	import { getContext, onMount, tick } from 'svelte';
	import { play as playSound } from '../../scripts/audio.ts';
	import { t } from '../../scripts/language.ts';
	import { type NavAreaController, type NavPos, navItem } from '../../scripts/navArea.svelte.ts';
	import { filterOptions } from '../../scripts/selectSearch.ts';
	import Icon from '../Icon/Icon.svelte';
	interface Props {
		value?: string;
		options: readonly string[];
		label?: string | undefined;
		/** Search hint shown while the list is open. Defaults to the translated "Search". */
		placeholder?: string | undefined;
		selected?: boolean | undefined;
		fontSize?: string | undefined;
		padding?: string | undefined;
		flex?: boolean | undefined;
		disabled?: boolean | undefined;
		onchange?: ((value: string) => void) | undefined;
		/** Position in NavArea grid [x, y]. When set, registers with parent NavArea. */
		position?: NavPos | undefined;
		el?: HTMLElement | undefined;
	}
	let { value = $bindable(''), options, label, placeholder, selected = false, fontSize = '2.5vh', padding = '1.5vh 2vh', flex = false, disabled = false, onchange, position, el = $bindable() }: Props = $props();
	const navArea = getContext<NavAreaController | undefined>('navArea');
	let isSelected = $derived(navArea && position ? navArea.isSelected(position) : selected);
	let inputElement: HTMLInputElement | undefined = $state();
	let listElement: HTMLElement | undefined = $state();
	let open = $state(false);
	let query = $state('');
	/**
	 * The highlighted option, held as its VALUE rather than as a position.
	 *
	 * A position silently means a different option the moment the list changes under
	 * it, and this list does change while open: the screen keeps reading the host, so
	 * the zone catalogue can be replaced, and every keystroke re-filters it. Measured
	 * on the time screen with an index: opening the list highlighted `Europe/Moscow`
	 * four rows off the `Europe/Prague` that was actually selected.
	 */
	let activeValue = $state<string | null>(null);
	/** Set when the list has more room above the field than below it. See {@link openList}. */
	let dropUp = $state(false);
	let matches = $derived(filterOptions(options, query));
	let activeIndex = $derived(activeValue === null ? -1 : matches.indexOf(activeValue));
	/** Worst case height of the open list, matching `max-height` in the style below. */
	const LIST_MAX_HEIGHT_PX = 260;
	// Unique per instance so the ARIA references still work with two of these on one screen.
	const listID = `select-search-${Math.random().toString(36).slice(2, 10)}`;
	let displayValue = $derived(open ? query : value);
	let searchPlaceholder = $derived(placeholder ?? $t('common.search'));

	// Keep the highlighted option on screen while the arrows walk a list far longer
	// than its box. `block: 'nearest'` scrolls only when it actually left the view.
	$effect(() => {
		if (!open || activeIndex < 0) return;
		listElement?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
	});

	function openList(): void {
		if (disabled || open) return;
		query = '';
		// Start on the current value rather than the top: opening the list should show
		// where the setting stands now, which for a mid-alphabet zone is nowhere near it.
		activeValue = options.includes(value) ? value : (options[0] ?? null);
		// The zone row sits near the bottom of the time screen, where a list opening
		// downwards is cut off by the window. Measured once per opening, which is when the
		// only thing that can move the field - scrolling - has already happened.
		const box = el?.getBoundingClientRect();
		dropUp = box ? window.innerHeight - box.bottom < LIST_MAX_HEIGHT_PX && box.top > window.innerHeight - box.bottom : false;
		open = true;
		void tick().then(() => inputElement?.focus());
	}

	function closeList(): void {
		open = false;
		query = '';
		activeValue = null;
	}

	function pick(option: string): void {
		closeList();
		if (option !== value) {
			value = option;
			onchange?.(value);
		}
		inputElement?.focus();
	}

	function handleFieldClick(): void {
		if (disabled) return;
		// Clicking the field opens the list, every time - including right after a pick,
		// which is the one case a native select makes hard. Clicking it while the list
		// is already open must NOT close it: that click is how the caret gets placed in
		// a query that is being typed. The caret button and Escape are the way out.
		if (open) return;
		playSound('confirm');
		openList();
	}

	function handleCaretClick(event: MouseEvent): void {
		if (disabled) return;
		event.stopPropagation();
		playSound('confirm');
		if (open) {
			closeList();
			inputElement?.focus();
		} else openList();
	}

	function handleInput(event: Event): void {
		query = (event.target as HTMLInputElement).value;
		open = true;
		// The best match of the narrowed list, so Enter picks what the user is looking at.
		activeValue = matches[0] ?? null;
	}

	function step(offset: number): void {
		if (matches.length === 0) return;
		const from = activeIndex < 0 ? (offset > 0 ? -1 : 0) : activeIndex;
		activeValue = matches[(from + offset + matches.length) % matches.length] ?? null;
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (disabled) return;
		switch (event.key) {
			case 'ArrowDown':
			case 'ArrowUp':
				event.preventDefault();
				if (!open) openList();
				else step(event.key === 'ArrowDown' ? 1 : -1);
				return;
			case 'Home':
			case 'End':
				if (!open || matches.length === 0) return;
				event.preventDefault();
				activeValue = (event.key === 'Home' ? matches[0] : matches[matches.length - 1]) ?? null;
				return;
			case 'Enter': {
				event.preventDefault();
				if (!open) {
					openList();
					return;
				}
				// Nothing highlighted (the filter moved past it) still picks the best match,
				// so Enter never silently does nothing while the list shows candidates.
				const option = activeIndex >= 0 ? matches[activeIndex] : matches[0];
				if (option !== undefined) pick(option);
				return;
			}
			case 'Escape':
				if (!open) return;
				// The list is what Escape closes here. Left to bubble it would reach the
				// global back handler and leave the whole screen instead.
				event.preventDefault();
				event.stopPropagation();
				closeList();
				return;
			case 'Tab':
				if (open) closeList();
				return;
			default:
				return;
		}
	}

	function handleFocusOut(event: FocusEvent): void {
		// Only when focus left the component for good: moving between the field and its
		// own list must not close it.
		const next = event.relatedTarget;
		if (next instanceof Node && el?.contains(next)) return;
		closeList();
	}

	onMount(() => {
		if (navArea && position)
			return navArea.register(
				navItem(
					() => position!,
					() => el,
					() => openList(),
					{ noDelegateMouse: true }
				)
			);
		return undefined;
	});
</script>

<style>
	.select-search {
		display: flex;
		flex-direction: column;
		gap: 0.5vh;
		position: relative;
		min-width: 0;
	}

	.label {
		font-size: 2vh;
		color: var(--disabled-foreground);
	}

	.field {
		display: flex;
		align-items: center;
		gap: 0.5vh;
		padding-right: var(--select-padding);
		border: 0.3vh solid var(--secondary-softer-background);
		border-radius: 1vh;
		background-color: var(--secondary-background);
		color: var(--secondary-foreground);
		cursor: pointer;
		transition: border-color 0.2s;
	}

	.field:focus-within,
	.select-search.selected .field {
		border-color: var(--primary-foreground);
	}

	input {
		flex: 1;
		min-width: 0;
		font-size: var(--select-font-size);
		font-family: inherit;
		padding: var(--select-padding);
		border: none;
		border-radius: 1vh;
		background-color: transparent;
		color: inherit;
		outline: none;
		cursor: inherit;
		text-overflow: ellipsis;
	}

	.caret {
		display: flex;
		align-items: center;
		border: none;
		padding: 0;
		background: none;
		cursor: inherit;
	}

	.list {
		position: absolute;
		z-index: 10;
		left: 0;
		right: 0;
		top: 100%;
		margin-top: 0.3vh;
		max-height: 34vh;
		overflow-y: auto;
		border: 0.3vh solid var(--primary-foreground);
		border-radius: 1vh;
		background-color: var(--secondary-background);
		box-shadow: 0 1vh 2vh rgba(0, 0, 0, 0.4);
	}

	.list.up {
		top: auto;
		bottom: 100%;
		margin-top: 0;
		margin-bottom: 0.3vh;
	}

	.option,
	.empty {
		padding: var(--select-padding);
		font-size: var(--select-font-size);
		color: var(--secondary-foreground);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.option {
		cursor: pointer;
	}

	.option.current {
		color: var(--primary-foreground);
	}

	.option.active {
		background-color: var(--secondary-softer-background);
	}

	.empty {
		color: var(--disabled-foreground);
	}

	.select-search.flex {
		flex: 1;
	}

	.select-search.disabled .field {
		background-color: var(--disabled-foreground);
		color: var(--disabled-background);
		border-color: var(--disabled-background);
		cursor: not-allowed;
	}

	.select-search.disabled input::placeholder {
		color: var(--disabled-background);
	}
</style>

<div bind:this={el} class="select-search" class:selected={isSelected} class:flex class:disabled style="--select-font-size: {fontSize}; --select-padding: {padding};" onfocusout={handleFocusOut}>
	{#if label}
		<div class="label">{label}:</div>
	{/if}
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="field" onclick={handleFieldClick}>
		<input bind:this={inputElement} type="text" role="combobox" aria-expanded={open} aria-controls={listID} aria-autocomplete="list" aria-activedescendant={open && activeIndex >= 0 ? `${listID}-${activeIndex}` : undefined} aria-label={label} value={displayValue} placeholder={open ? searchPlaceholder : ''} {disabled} autocomplete="off" spellcheck="false" oninput={handleInput} onkeydown={handleKeydown} />
		<button class="caret" type="button" tabindex="-1" aria-hidden="true" {disabled} onclick={handleCaretClick}>
			<Icon img={open ? '/img/arrow-up.svg' : '/img/arrow-down.svg'} size="2vh" colorVariable={disabled ? '--disabled-background' : '--secondary-foreground'} />
		</button>
	</div>
	{#if open}
		<div bind:this={listElement} class="list" class:up={dropUp} id={listID} role="listbox" aria-label={label}>
			{#each matches as option, index (option)}
				<!--
					The highlight follows the mouse on MOVE, not on enter: the list opens right
					under a cursor that has not moved, and on enter the option that happens to
					be there would steal the highlight from the selected value - so Enter right
					after opening would pick a zone nobody aimed at.
				-->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<div
					class="option"
					class:active={option === activeValue}
					class:current={option === value}
					role="option"
					id={`${listID}-${index}`}
					data-index={index}
					tabindex="-1"
					aria-selected={option === value}
					onmousedown={event => {
						// Before the click, so the field never loses focus to the option.
						event.preventDefault();
						pick(option);
					}}
					onmousemove={() => (activeValue = option)}
				>
					{option}
				</div>
			{/each}
			{#if matches.length === 0}
				<div class="empty">{$t('common.noResults')}</div>
			{/if}
		</div>
	{/if}
</div>
