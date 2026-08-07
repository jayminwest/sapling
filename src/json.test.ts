import { describe, expect, it } from "bun:test";
import { jsonError, jsonOutput, printJson, printJsonError } from "./json.ts";

describe("json envelope helpers", () => {
	it("jsonOutput wraps data in the success envelope", () => {
		const parsed = JSON.parse(jsonOutput("run", { turns: 3 })) as Record<string, unknown>;
		expect(parsed).toEqual({ success: true, command: "run", turns: 3 });
	});

	it("jsonError wraps a message and optional details in the error envelope", () => {
		const bare = JSON.parse(jsonError("run", "boom")) as Record<string, unknown>;
		expect(bare).toEqual({ success: false, command: "run", error: "boom" });
		const detailed = JSON.parse(jsonError("run", "boom", { code: 2 })) as Record<string, unknown>;
		expect(detailed).toEqual({ success: false, command: "run", error: "boom", code: 2 });
	});

	it("printJson and printJsonError write envelopes to stdout", () => {
		const lines: string[] = [];
		const original = console.log;
		console.log = (line: string) => {
			lines.push(line);
		};
		try {
			printJson("status", { ok: 1 });
			printJsonError("status", "nope");
		} finally {
			console.log = original;
		}
		expect(JSON.parse(lines[0] ?? "")).toEqual({ success: true, command: "status", ok: 1 });
		expect(JSON.parse(lines[1] ?? "")).toEqual({
			success: false,
			command: "status",
			error: "nope",
		});
	});
});
