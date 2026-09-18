/**
 * Guards the footer widget documentation on the help page.
 *
 * The help page renders one row per entry of `footerWidgets` and looks the
 * description up as `help.footerWidgets.<id>`. A widget added to the list
 * without a matching translation would render the raw key, so every language
 * file must stay in sync with the widget list.
 */
import { test, expect } from 'bun:test';
import { footerWidgets } from '../../src/scripts/footerWidgets.ts';

// The language list lives next to the API client, whose constructor opens a socket the
// moment the module is loaded. This file only reads local JSON, so it lends the import a
// socket that does nothing and hands the real one straight back: a translation check has
// no business dialling a server, and the attempt would fail on whatever port happens to
// answer. Narrower than replacing the api module, whose mock registry is shared by every
// test file in the run.
const realWebSocket = globalThis.WebSocket;
(globalThis as any).WebSocket = class {
	close(): void {}
	send(): void {}
	addEventListener(): void {}
	removeEventListener(): void {}
};
const { languages } = await import('../../src/scripts/language.ts');
globalThis.WebSocket = realWebSocket;

async function loadHelpFooterWidgets(langID: string): Promise<Record<string, string>> {
	const data = await Bun.file(new URL(`../../static/langs/${langID}.json`, import.meta.url)).json();
	return data.help?.footerWidgets ?? {};
}

for (const { id: langID } of languages) {
	test(`${langID}.json describes every footer widget`, async () => {
		const section = await loadHelpFooterWidgets(langID);
		// Non-empty, not merely present: an entry emptied by a bad edit is a row that
		// renders as nothing, which the page cannot distinguish from a documented widget.
		expect(section['title']?.trim()).toBeTruthy();
		for (const widget of footerWidgets) expect(section[widget]?.trim()).toBeTruthy();
	});

	test(`${langID}.json has no description for an unknown widget`, async () => {
		const section = await loadHelpFooterWidgets(langID);
		const documented = Object.keys(section).filter(key => key !== 'title');
		expect(documented.sort()).toEqual([...footerWidgets].sort());
	});
}
