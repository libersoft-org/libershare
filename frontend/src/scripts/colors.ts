import { hexToCSSFilter } from 'hex-to-css-filter';

export function getColorFromCSSToFilter(name: string) {
	//console.log('getColorFromCSSToFilter');
	//console.log(name);
	if (!name.startsWith('--')) throw new Error('getColorFromCSSToFilter: name must start with --');
	let v = getColorFromCSS(name);
	if (!v) throw new Error(`getColorFromCSSToFilter: ${name} not found`);
	v = convertFromShortHex(v);
	//console.log('getColorFromCSSToFilter', name, 'v=', v);
	return hexToCSSFilter(v).filter;
}

export function convertFromShortHex(v: string) {
	//console.log('convertFromShortHex', v);
	if (v.length === 4) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
	//console.log('convertFromShortHex=', v);
	return v;
}

export function getColorFromCSS(name: string) {
	return getComputedStyle(document.documentElement).getPropertyValue(name);
}
