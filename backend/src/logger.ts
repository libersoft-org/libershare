import { createConsola, LogLevels, type ConsolaReporter, type LogObject } from 'consola';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'fs';
import { dirname } from 'path';
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
const levelMap: Record<LogLevel, number> = {
	trace: LogLevels.trace,
	debug: LogLevels.debug,
	info: LogLevels.info,
	warn: LogLevels.warn,
	error: LogLevels.error,
};
const levelNames: Record<number, string> = {
	[LogLevels.trace]: 'TRACE',
	[LogLevels.debug]: 'DEBUG',
	[LogLevels.info]: 'INFO',
	[LogLevels.warn]: 'WARN',
	[LogLevels.error]: 'ERROR',
};
const LOG_PREFIX = process.env['LOG_PREFIX'] || '';

// JSON.stringify drops Error.name/message/stack (non-enumerable). This serializer keeps them
// (and includes any custom properties like libp2p's `code`/`context`) so log lines stay diagnosable.
function serializeArg(arg: unknown): string {
	if (arg instanceof Error) {
		const extra: Record<string, unknown> = {};
		for (const key of Object.keys(arg)) extra[key] = (arg as any)[key];
		const extraStr = Object.keys(extra).length ? ' ' + JSON.stringify(extra) : '';
		return `${arg.name}: ${arg.message}${extraStr}\n${arg.stack ?? ''}`;
	}
	if (typeof arg === 'object' && arg !== null) {
		try {
			return JSON.stringify(arg);
		} catch {
			return String(arg);
		}
	}
	return String(arg);
}

function formatTimestamp(date: Date): string {
	function pad(n: number, len = 2): string {
		return n.toString().padStart(len, '0');
	}
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

const levelColors: Record<string, string> = {
	TRACE: '\x1b[90m', // gray
	DEBUG: '\x1b[36m', // cyan
	INFO: '\x1b[32m', // green
	WARN: '\x1b[33m', // yellow
	ERROR: '\x1b[31m', // red
};
const RESET = '\x1b[0m';

function createPreciseReporter(): ConsolaReporter {
	return {
		log(logObj: LogObject): void {
			const timestamp = formatTimestamp(logObj.date);
			const levelName = levelNames[logObj.level] || 'INFO';
			const prefix = LOG_PREFIX ? `[${LOG_PREFIX}] ` : '';
			const args = logObj.args.map(serializeArg).join(' ');
			const color = levelColors[levelName] || '';
			const levelTag = color ? `${color}[${levelName}]${RESET}` : `[${levelName}]`;
			const output = `${prefix}[${timestamp}] ${levelTag} ${args}`;
			if (logObj.level <= LogLevels.error) process.stderr.write(output + '\n');
			else process.stdout.write(output + '\n');
		},
	};
}

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_FILES = 3;

function rotateLogFile(filePath: string): void {
	try {
		const size = statSync(filePath).size;
		if (size < MAX_LOG_SIZE) return;
		for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
			try {
				renameSync(`${filePath}.${i}`, `${filePath}.${i + 1}`);
			} catch {}
		}
		try {
			renameSync(filePath, `${filePath}.1`);
		} catch {}
	} catch {}
}

function createFileReporter(filePath: string): ConsolaReporter {
	try {
		mkdirSync(dirname(filePath), { recursive: true });
	} catch {}
	let writeCount = 0;
	return {
		log(logObj: LogObject): void {
			const timestamp = formatTimestamp(logObj.date);
			const levelName = levelNames[logObj.level] || 'INFO';
			const prefix = LOG_PREFIX ? `[${LOG_PREFIX}] ` : '';
			const args = logObj.args.map(serializeArg).join(' ');
			const line = `${prefix}[${timestamp}] [${levelName}] ${args}\n`;
			try {
				appendFileSync(filePath, line);
			} catch {}
			if (++writeCount % 1000 === 0) rotateLogFile(filePath);
		},
	};
}

let _consola: ReturnType<typeof createConsola> | null = null;

export function setupLogger(level: LogLevel = 'info', logFile?: string): ReturnType<typeof createConsola> {
	const reporters: ConsolaReporter[] = [createPreciseReporter()];
	if (logFile) reporters.push(createFileReporter(logFile));
	_consola = createConsola({
		level: levelMap[level],
		reporters,
	});
	_consola.wrapConsole();
	return _consola;
}

/** Trace-level log without stack trace (unlike console.trace which adds stack in consola). */
export function trace(...args: any[]): void {
	_consola?.trace(...(args as [any, ...any[]]));
}
