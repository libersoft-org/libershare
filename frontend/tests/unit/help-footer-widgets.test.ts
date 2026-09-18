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
import { languages } from '../../src/scripts/language.ts';

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
