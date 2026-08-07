import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

export const CONFIG_FILE_NAME = "python.json";

export interface PythonConfig {
	executable: "auto" | string;
	utf8: boolean;
	unbuffered: boolean;
}

export const DEFAULT_CONFIG: Readonly<PythonConfig> = Object.freeze({
	executable: "auto",
	utf8: true,
	unbuffered: true,
});

const CONFIG_KEYS = new Set<keyof PythonConfig>(Object.keys(DEFAULT_CONFIG) as Array<keyof PythonConfig>);
const ENV_FIELDS = {
	PI_PYTHON_EXECUTABLE: "executable",
	PI_PYTHON_UTF8: "utf8",
	PI_PYTHON_UNBUFFERED: "unbuffered",
} as const;

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

function parseBoolean(value: unknown, field: string, source: string): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		switch (value.trim().toLowerCase()) {
			case "1":
			case "true":
			case "yes":
			case "on":
				return true;
			case "0":
			case "false":
			case "no":
			case "off":
				return false;
		}
	}
	throw new ConfigError(`${source}: ${field} must be a boolean (true/false, 1/0, yes/no, or on/off)`);
}

function parseExecutable(value: unknown, source: string): "auto" | string {
	if (typeof value !== "string" || !value.trim()) {
		throw new ConfigError(`${source}: executable must be "auto" or an absolute path to Python 3`);
	}
	const executable = value.trim();
	if (executable.toLowerCase() === "auto") return "auto";
	if (!isAbsolute(executable)) {
		throw new ConfigError(`${source}: executable must be an absolute path, received ${JSON.stringify(executable)}`);
	}
	return normalize(executable);
}

function parseConfigObject(value: unknown, source: string): Partial<PythonConfig> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ConfigError(`${source}: configuration must be a JSON object`);
	}
	const input = value as Record<string, unknown>;
	const unknown = Object.keys(input).filter((key) => !CONFIG_KEYS.has(key as keyof PythonConfig));
	if (unknown.length > 0) {
		throw new ConfigError(`${source}: unknown configuration field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
	}
	const parsed: Partial<PythonConfig> = {};
	if ("executable" in input) parsed.executable = parseExecutable(input.executable, source);
	if ("utf8" in input) parsed.utf8 = parseBoolean(input.utf8, "utf8", source);
	if ("unbuffered" in input) parsed.unbuffered = parseBoolean(input.unbuffered, "unbuffered", source);
	return parsed;
}

function parseEnvironment(env: NodeJS.ProcessEnv): Partial<PythonConfig> {
	const parsed: Partial<PythonConfig> = {};
	for (const [environmentName, field] of Object.entries(ENV_FIELDS) as Array<
		[keyof typeof ENV_FIELDS, (typeof ENV_FIELDS)[keyof typeof ENV_FIELDS]]
	>) {
		const value = env[environmentName];
		if (value === undefined) continue;
		const source = `environment variable ${environmentName}`;
		if (field === "executable") parsed.executable = parseExecutable(value, source);
		else parsed[field] = parseBoolean(value, field, source);
	}
	return parsed;
}

export interface LoadConfigOptions {
	agentDir: string;
	env?: NodeJS.ProcessEnv;
	readFile?: typeof readFileSync;
}

export interface LoadedConfig {
	config: PythonConfig;
	path: string;
}

export function loadConfig({ agentDir, env = process.env, readFile = readFileSync }: LoadConfigOptions): LoadedConfig {
	const explicitPath = env.PI_PYTHON_CONFIG?.trim();
	const path = explicitPath || join(agentDir, CONFIG_FILE_NAME);
	let fileConfig: Partial<PythonConfig> = {};
	try {
		const text = readFile(path, "utf8");
		let json: unknown;
		try {
			json = JSON.parse(text.replace(/^\uFEFF/, ""));
		} catch (error) {
			throw new ConfigError(`${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		fileConfig = parseConfigObject(json, path);
	} catch (error) {
		if (error instanceof ConfigError) throw error;
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && explicitPath) {
			throw new ConfigError(`${path}: configured file was not found`);
		}
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new ConfigError(`${path}: unable to read configuration: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return {
		path,
		config: {
			...DEFAULT_CONFIG,
			...fileConfig,
			...parseEnvironment(env),
		},
	};
}
