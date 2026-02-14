import { createConsola, LogLevels, type ConsolaReporter, type LogObject } from 'consola';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const levelMap: Record<LogLevel, number> = {
	debug: LogLevels.debug,
	info: LogLevels.info,
	warn: LogLevels.warn,
	error: LogLevels.error,
};
const levelNames: Record<number, string> = {
	[LogLevels.debug]: 'DEBUG',
	[LogLevels.info]: 'INFO',
	[LogLevels.warn]: 'WARN',
	[LogLevels.error]: 'ERROR',
};
const LOG_PREFIX = process.env.LOG_PREFIX || '';

function formatTimestamp(date: Date): string {
	const pad = (n: number, len = 2) => n.toString().padStart(len, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

const levelColors: Record<string, string> = {
	DEBUG: '\x1b[36m', // cyan
	INFO: '\x1b[32m',  // green
	WARN: '\x1b[33m',  // yellow
	ERROR: '\x1b[31m', // red
};
const RESET = '\x1b[0m';

function createPreciseReporter(): ConsolaReporter {
	return {
		log(logObj: LogObject) {
			const timestamp = formatTimestamp(logObj.date);
			const levelName = levelNames[logObj.level] || 'INFO';
			const prefix = LOG_PREFIX ? `[${LOG_PREFIX}] ` : '';
			const args = logObj.args.map(arg => (typeof arg === 'object' ? JSON.stringify(arg) : arg)).join(' ');
			const color = levelColors[levelName] || '';
			const levelTag = color ? `${color}[${levelName}]${RESET}` : `[${levelName}]`;
			const output = `${prefix}[${timestamp}] ${levelTag} ${args}`;
			if (logObj.level <= LogLevels.error) process.stderr.write(output + '\n');
			else process.stdout.write(output + '\n');
		},
	};
}

export function setupLogger(level: LogLevel = 'info') {
	const consola = createConsola({
		level: levelMap[level],
		reporters: [createPreciseReporter()],
	});
	consola.wrapConsole();
	return consola;
}
