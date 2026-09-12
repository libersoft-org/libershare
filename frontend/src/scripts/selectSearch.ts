/**
 * Text matching for the searchable select.
 *
 * Kept out of the component so it can be tested without a DOM, and because the
 * rules are the whole user experience of a 450-item list: they decide whether
 * typing "prague" finds `Europe/Prague` and whether "new york" finds
 * `America/New_York`.
 */

/**
 * Fold one label into the form both sides of a comparison are measured in.
 *
 * Diacritics go (so "asuncion" finds `America/Asunción`), case goes, and the
 * separators that only exist because a zone name is a path — `/` and `_` — become
 * spaces. That last part is what lets a term match a single word of the name
 * instead of having to know where the boundaries are.
 */
export function normalizeSearchText(value: string): string {
	return value
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase()
		.replace(/[_/\-.]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * The options a query matches, in the order they were given.
 *
 * Every whitespace-separated term has to appear somewhere in the folded label, so
 * the terms may be typed in any order and each one narrows the list further: "am
 * new" and "new am" both reach `America/New_York`. An empty query matches
 * everything, which is what makes the list open on the full catalogue.
 *
 * ponytail: no relevance ranking - the list stays in the order the caller passed
 * (alphabetical for time zones). Add ranking only if a real query turns out to
 * bury the obvious answer.
 */
export function filterOptions(options: readonly string[], query: string): string[] {
	const terms = normalizeSearchText(query).split(' ').filter(Boolean);
	if (terms.length === 0) return [...options];
	return options.filter(option => {
		const normalized = normalizeSearchText(option);
		return terms.every(term => normalized.includes(term));
	});
}
