/**
 * Context Pipeline v1 — Stage Registry
 *
 * StageRegistry holds an ordered list of PipelineStage instances and
 * executes them sequentially, passing a shared StageContext through each.
 *
 * Default stages: ingest → evaluate → compact → budget → render
 *
 * External callers can register, replace, or remove stages to customize
 * the pipeline without editing source.
 */

import type { Message } from "../../types.ts";
import { budget, estimateTokens } from "./budget.ts";
import { compact } from "./compact.ts";
import { evaluate } from "./evaluate.ts";
import { ingest } from "./ingest.ts";
import { render } from "./render.ts";
import type { PipelineStage, StageContext } from "./types.ts";

export type { PipelineStage, StageContext };

// ---------------------------------------------------------------------------
// StageRegistry
// ---------------------------------------------------------------------------

export class StageRegistry {
	private stages: PipelineStage[];

	constructor(stages: PipelineStage[] = []) {
		this.stages = [...stages];
	}

	/**
	 * Append a new stage to the end of the pipeline.
	 * If a stage with the same name already exists, it is replaced in place.
	 */
	register(stage: PipelineStage): void {
		const idx = this.stages.findIndex((s) => s.name === stage.name);
		if (idx !== -1) {
			this.stages[idx] = stage;
		} else {
			this.stages.push(stage);
		}
	}

	/**
	 * Replace an existing stage by name.
	 * Throws if no stage with that name is registered.
	 */
	replace(name: string, stage: PipelineStage): void {
		const idx = this.stages.findIndex((s) => s.name === name);
		if (idx === -1) {
			throw new Error(`StageRegistry: no stage named '${name}'`);
		}
		this.stages[idx] = stage;
	}

	/**
	 * Remove a stage by name.
	 * Returns true if the stage was found and removed, false otherwise.
	 */
	remove(name: string): boolean {
		const idx = this.stages.findIndex((s) => s.name === name);
		if (idx === -1) return false;
		this.stages.splice(idx, 1);
		return true;
	}

	/**
	 * Retrieve a stage by name without removing it.
	 * Returns undefined if not found.
	 */
	get(name: string): PipelineStage | undefined {
		return this.stages.find((s) => s.name === name);
	}

	/** Returns true if a stage with the given name is registered. */
	has(name: string): boolean {
		return this.stages.some((s) => s.name === name);
	}

	/** Returns a snapshot of all registered stages in order. */
	list(): PipelineStage[] {
		return [...this.stages];
	}

	/**
	 * Execute all stages sequentially, passing ctx through each.
	 * Stages may mutate ctx (operations, activeOperationId, budgetUtil, output).
	 */
	run(ctx: StageContext): void {
		for (const stage of this.stages) {
			stage.execute(ctx);
		}
	}
}

// ---------------------------------------------------------------------------
// Default stage implementations
// ---------------------------------------------------------------------------

const ingestStage: PipelineStage = {
	name: "ingest",
	execute(ctx: StageContext): void {
		const result = ingest(
			ctx.input.messages,
			ctx.operations,
			ctx.activeOperationId,
			ctx.nextOperationId ?? 1,
		);
		ctx.operations = result.operations;
		ctx.activeOperationId = result.activeOperationId;
		ctx.nextOperationId = result.nextOperationId;

		if (ctx.verbose) {
			const activeOp = ctx.operations.find((op) => op.id === ctx.activeOperationId);
			console.error(
				`[pipeline-v1] ingest: ${ctx.operations.length} ops, active=${ctx.activeOperationId}, ` +
					`turns=${activeOp?.turns.length ?? 0}`,
			);
		}
	},
};

const evaluateStage: PipelineStage = {
	name: "evaluate",
	execute(ctx: StageContext): void {
		evaluate(ctx.operations);

		if (ctx.verbose) {
			for (const op of ctx.operations) {
				console.error(
					`[pipeline-v1] evaluate: op#${op.id} (${op.type}) score=${op.score.toFixed(3)} status=${op.status}`,
				);
			}
		}
	},
};

const compactStage: PipelineStage = {
	name: "compact",
	execute(ctx: StageContext): void {
		compact(ctx.operations, ctx.activeOperationId);

		if (ctx.verbose) {
			const compacted = ctx.operations.filter((op) => op.status === "compacted").length;
			console.error(`[pipeline-v1] compact: ${compacted} ops compacted`);
		}
	},
};

const budgetStage: PipelineStage = {
	name: "budget",
	execute(ctx: StageContext): void {
		const systemTokens = estimateTokens(ctx.input.systemPrompt);
		ctx.budgetUtil = budget(ctx.operations, systemTokens, ctx.windowSize);

		if (ctx.verbose) {
			const archived = ctx.operations.filter((op) => op.status === "archived").length;
			console.error(
				`[pipeline-v1] budget: utilization=${(ctx.budgetUtil.utilization * 100).toFixed(1)}%, archived=${archived}`,
			);
		}
	},
};

const renderStage: PipelineStage = {
	name: "render",
	execute(ctx: StageContext): void {
		if (!ctx.budgetUtil) {
			throw new Error("render stage requires budgetUtil — run the budget stage first");
		}

		const taskMessage = ctx.input.messages[0] as Message;
		const retainedOps = ctx.operations.filter((op) => op.status !== "archived");
		const archivedOps = ctx.operations.filter((op) => op.status === "archived");

		ctx.output = render(
			taskMessage,
			retainedOps,
			archivedOps,
			ctx.input.systemPrompt,
			ctx.operations,
			ctx.activeOperationId,
			ctx.budgetUtil,
		);

		if (ctx.verbose) {
			console.error(
				`[pipeline-v1] render: ${ctx.output.messages.length} messages, ` +
					`${archivedOps.length} archive entries`,
			);
		}
	},
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a StageRegistry pre-loaded with the five default pipeline stages
 * in canonical order: ingest → evaluate → compact → budget → render.
 */
export function createDefaultStageRegistry(): StageRegistry {
	return new StageRegistry([ingestStage, evaluateStage, compactStage, budgetStage, renderStage]);
}
