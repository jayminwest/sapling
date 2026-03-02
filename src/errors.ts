export class SaplingError extends Error {
	readonly code: string;

	constructor(message: string, code: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SaplingError";
		this.code = code;
	}
}

export class ClientError extends SaplingError {
	constructor(message: string, code: string, options?: ErrorOptions) {
		super(message, code, options);
		this.name = "ClientError";
	}
}

export class ToolError extends SaplingError {
	constructor(message: string, code: string, options?: ErrorOptions) {
		super(message, code, options);
		this.name = "ToolError";
	}
}

export class ContextError extends SaplingError {
	constructor(message: string, code: string, options?: ErrorOptions) {
		super(message, code, options);
		this.name = "ContextError";
	}
}

export class ConfigError extends SaplingError {
	constructor(message: string, code: string, options?: ErrorOptions) {
		super(message, code, options);
		this.name = "ConfigError";
	}
}
