import { describe, expect, test } from "bun:test";
import { suggestCommand } from "./typo.ts";

describe("suggestCommand", () => {
	const candidates = ["run", "version", "completions", "upgrade", "doctor", "help"];

	test("exact match returns itself", () => {
		expect(suggestCommand("run", candidates)).toBe("run");
	});

	test("one-character typo suggests correct command", () => {
		expect(suggestCommand("rn", candidates)).toBe("run");
		expect(suggestCommand("versoin", candidates)).toBe("version");
		expect(suggestCommand("doctr", candidates)).toBe("doctor");
	});

	test("two-character typo suggests correct command", () => {
		expect(suggestCommand("upgade", candidates)).toBe("upgrade");
	});

	test("completely different string returns undefined", () => {
		expect(suggestCommand("xyznotacommand", candidates)).toBeUndefined();
	});

	test("empty candidates returns undefined", () => {
		expect(suggestCommand("run", [])).toBeUndefined();
	});
});
