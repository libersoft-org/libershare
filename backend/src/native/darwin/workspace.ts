import { ObjectiveC } from './objc.ts';

export function openMacPath(path: string): void {
	if (!path.startsWith('/') || path.includes('\0')) throw new Error('Invalid local path');
	const objc = new ObjectiveC('AppKit');
	try {
		const workspace = objc.get(objc.klass('NSWorkspace'), 'sharedWorkspace');
		const url = objc.calls.symbols.objectArg(objc.klass('NSURL'), objc.selector('fileURLWithPath:'), objc.string(path));
		if (!workspace || !url || !objc.calls.symbols.flagArg(workspace, objc.selector('openURL:'), url)) throw new Error('macOS could not open the file in the current graphical session');
	} finally {
		objc.close();
	}
}
