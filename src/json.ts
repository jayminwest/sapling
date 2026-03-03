/**
 * Standardized JSON envelope helpers for Sapling CLI output.
 *
 * Success envelope: { "success": true, "command": "<name>", ...data }
 * Error envelope:   { "success": false, "command": "<name>", "error": "<message>", ...details }
 */

export interface JsonSuccess {
	success: true;
	command: string;
	[key: string]: unknown;
}

export interface JsonErrorEnvelope {
	success: false;
	command: string;
	error: string;
	[key: string]: unknown;
}

/**
 * Wrap data in the standard success envelope.
 */
export function jsonOutput<T extends Record<string, unknown>>(command: string, data: T): string {
	const envelope: JsonSuccess = {
		success: true,
		command,
		...data,
	};
	return JSON.stringify(envelope);
}

/**
 * Wrap an error in the standard error envelope.
 */
export function jsonError(
	command: string,
	message: string,
	details?: Record<string, unknown>,
): string {
	const envelope: JsonErrorEnvelope = {
		success: false,
		command,
		error: message,
		...(details ?? {}),
	};
	return JSON.stringify(envelope);
}

/**
 * Print a success envelope to stdout.
 */
export function printJson<T extends Record<string, unknown>>(command: string, data: T): void {
	console.log(jsonOutput(command, data));
}

/**
 * Print an error envelope to stdout (JSON mode keeps everything on stdout).
 */
export function printJsonError(
	command: string,
	message: string,
	details?: Record<string, unknown>,
): void {
	console.log(jsonError(command, message, details));
}
