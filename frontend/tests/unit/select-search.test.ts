import { describe, expect, it } from 'bun:test';
import { filterOptions, normalizeSearchText } from '../../src/scripts/selectSearch.ts';

const ZONES = ['Africa/Abidjan', 'America/Argentina/San_Juan', 'America/New_York', 'America/Asuncion', 'Asia/Ho_Chi_Minh', 'Europe/Prague', 'Europe/Paris', 'Pacific/Port_Moresby'];

describe('searchable select matching', () => {
	it('folds a label into the form both sides are compared in', () => {
		expect(normalizeSearchText('America/New_York')).toBe('america new york');
		expect(normalizeSearchText('  Europe/Prague  ')).toBe('europe prague');
		expect(normalizeSearchText('Asunción')).toBe('asuncion');
	});

	it('matches a city without its region', () => {
		expect(filterOptions(ZONES, 'prague')).toEqual(['Europe/Prague']);
		expect(filterOptions(ZONES, 'moresby')).toEqual(['Pacific/Port_Moresby']);
	});

	/** The underscore is a separator in the data, not something anyone types. */
	it('matches across the underscores in a zone name', () => {
		expect(filterOptions(ZONES, 'new york')).toEqual(['America/New_York']);
		expect(filterOptions(ZONES, 'ho chi minh')).toEqual(['Asia/Ho_Chi_Minh']);
	});

	it('takes the terms in any order and narrows with each one', () => {
		expect(filterOptions(ZONES, 'europe')).toEqual(['Europe/Prague', 'Europe/Paris']);
		expect(filterOptions(ZONES, 'europe p')).toEqual(['Europe/Prague', 'Europe/Paris']);
		expect(filterOptions(ZONES, 'europe pa')).toEqual(['Europe/Paris']);
		expect(filterOptions(ZONES, 'paris europe')).toEqual(['Europe/Paris']);
	});

	it('ignores case and diacritics on both sides', () => {
		expect(filterOptions(ZONES, 'ASUNCIÓN')).toEqual(['America/Asuncion']);
		expect(filterOptions(ZONES, 'asuncion')).toEqual(['America/Asuncion']);
	});

	/** An empty query is what opening the list uses, so it has to mean "everything". */
	it('matches everything for an empty or blank query', () => {
		expect(filterOptions(ZONES, '')).toEqual(ZONES);
		expect(filterOptions(ZONES, '   ')).toEqual(ZONES);
	});

	it('returns nothing for a query no label contains', () => {
		expect(filterOptions(ZONES, 'atlantis')).toEqual([]);
	});

	it('does not hand back the caller own array', () => {
		const result = filterOptions(ZONES, '');
		result.push('Extra/Zone');
		expect(ZONES).toHaveLength(8);
	});
});
