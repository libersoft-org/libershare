/** Preserve retryable disk-full failures from both Win32 disk-full error codes. */
export function windowsDatasetError(operation: string, number: number): NodeJS.ErrnoException {
	const code = number === 2 || number === 3 ? 'ENOENT' : number === 80 || number === 183 ? 'EEXIST' : number === 5 || number === 32 ? 'EACCES' : number === 39 || number === 112 ? 'ENOSPC' : number === 145 ? 'ENOTEMPTY' : 'EIO';
	return Object.assign(new Error(`${operation} failed (Windows error ${number})`), { code });
}
