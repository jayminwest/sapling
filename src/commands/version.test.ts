import { describe, expect, test } from "bun:test";
import { compareSemver, getCurrentVersion } from "./version.ts";

describe("getCurrentVersion", () => {
	test("returns a semver string", () => {
		const v = getCurrentVersion();
		expect(v).toMatch(/^\d+\.\d+\.\d+/);
	});
});

describe("compareSemver", () => {
	test("equal versions return 0", () => {
		expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
	});

	test("a < b returns -1", () => {
		expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
		expect(compareSemver("0.9.9", "1.0.0")).toBe(-1);
		expect(compareSemver("1.1.0", "1.2.0")).toBe(-1);
	});

	test("a > b returns 1", () => {
		expect(compareSemver("1.0.1", "1.0.0")).toBe(1);
		expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
	});

	test("handles missing patch segment", () => {
		expect(compareSemver("1.0", "1.0.0")).toBe(0);
		expect(compareSemver("1.1", "1.0.9")).toBe(1);
	});
});
