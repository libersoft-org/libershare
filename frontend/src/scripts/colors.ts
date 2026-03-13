import { hexToCSSFilter } from 'hex-to-css-filter';

export function getColorFromCSSToFilter(name: string): string {
	if (!name.startsWith('--')) throw new Error('getColorFromCSSToFilter: name must start with --');
	let v = getColorFromCSS(name);
	if (!v) throw new Error(`getColorFromCSSToFilter: ${name} not found`);
	v = convertFromShortHex(v);
	return hexToCSSFilter(v).filter;
}

export function convertFromShortHex(v: string): string {
	if (v.length === 4) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
	return v;
}

export function getColorFromCSS(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name);
}
