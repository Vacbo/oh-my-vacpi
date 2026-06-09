import { describe, expect, it } from "bun:test";
import { prompt } from "@oh-my-pi/pi-utils";
import planModeApprovedPrompt from "../../src/prompts/system/plan-mode-approved.md" with { type: "text" };

describe("plan-mode-approved prompt", () => {
	it("includes plan artifact path in injected execution prompt", () => {
		const rendered = prompt.render(planModeApprovedPrompt, {
			planContent: "1. Do work",
			planFilePath: "local://WP_MIGRATION_PLAN.md",
		});

		expect(rendered).toContain("local://WP_MIGRATION_PLAN.md");
	});
});
