import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "sapling-test-"));
}

export async function cleanupTempDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}
