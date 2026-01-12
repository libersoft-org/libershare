import { createConsola, LogLevels } from 'consola';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelMap: Record<LogLevel, number> = {
	debug: LogLevels.debug,
	info: LogLevels.info,
	warn: LogLevels.warn,
	error: LogLevels.error,
};

export function setupLogger(level: LogLevel = 'info') {
	const consola = createConsola({
		level: levelMap[level],
		formatOptions: {
			date: true,
			colors: true,
			compact: false,
		},
	});

	consola.wrapConsole();

	return consola;
}
