<script lang="ts">
	/**
	 * Wraps its children in their own declarative NavArea, so one page can hold several areas: a
	 * component gets one NavArea context, and Buttons, TableRows or Tabs inside register into the
	 * nearest one.
	 */
	import { type Snippet, onMount } from 'svelte';
	import { createNavArea, type NavAreaController, type NavAreaOptions, type NavItem } from '../../scripts/navArea.svelte.ts';
	interface Props {
		/** Read once on mount, like createNavArea does; the hooks inside them stay live. */
		options: NavAreaOptions;
		/** An item of the area's own, e.g. a list that walks its rows itself (NavItem.onNavigate). */
		item?: NavItem | undefined;
		children: Snippet;
	}
	let { options, item, children }: Props = $props();
	const nav = createNavArea(() => options);
	/** For a parent that moves the selection before it activates the area, or reads it for styling. */
	export const controller: NavAreaController = nav.controller;

	onMount(() => (item ? nav.controller.register(item) : undefined));
</script>

{@render children()}
