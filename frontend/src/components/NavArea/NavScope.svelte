<script lang="ts">
	/**
	 * Wraps its children in their own declarative NavArea, so one page can hold several areas: a
	 * component gets one NavArea context, and Buttons, TableRows or Tabs inside register into the
	 * nearest one.
	 */
	import { type Snippet } from 'svelte';
	import { createNavArea, type NavAreaController, type NavAreaOptions } from '../../scripts/navArea.svelte.ts';
	interface Props {
		/** Read once on mount, like createNavArea does; the hooks inside them stay live. */
		options: NavAreaOptions;
		children: Snippet;
	}
	let { options, children }: Props = $props();
	const nav = createNavArea(() => options);
	/** For a parent that moves the selection before it activates the area, or reads it for styling. */
	export const controller: NavAreaController = nav.controller;
</script>

{@render children()}
