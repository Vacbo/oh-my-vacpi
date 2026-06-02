import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/cli/args";
import { buildForkUpdateLaunchArgs, resolveForkRepoDir, resolveForkUpdateModelScope } from "../src/cli/update-cli";

const settingsWithSlowRole = {
	getModelRole(role: string): string | undefined {
		return role === "slow" ? "anthropic/claude-opus-4-5" : undefined;
	},
};

describe("fork update session launch", () => {
	it("uses PI_SLOW_MODEL as the update session model scope", () => {
		const scope = resolveForkUpdateModelScope({
			settings: settingsWithSlowRole,
			env: { PI_SLOW_MODEL: "openai/gpt-5.4" },
		});

		expect(scope).toBe("openai/gpt-5.4");
	});

	it("falls back to the configured slow role", () => {
		const scope = resolveForkUpdateModelScope({ settings: settingsWithSlowRole, env: {} });

		expect(scope).toBe("anthropic/claude-opus-4-5");
	});

	it("starts a fresh session with the fork merge prompt", () => {
		const args = buildForkUpdateLaunchArgs({ settings: settingsWithSlowRole, env: {} });
		const parsed = parseArgs([...args]);

		expect(parsed.newSession).toBe(true);
		expect(parsed.models).toEqual(["anthropic/claude-opus-4-5"]);
		expect(parsed.messages).toHaveLength(1);
		expect(parsed.messages[0]).toContain("Merge the latest upstream `can1357/oh-my-pi` tag into this fork.");
		expect(parsed.messages[0]).toContain("Do not run the legacy package or binary updater.");
	});

	it("pins the fork repo dir to the default checkout", () => {
		const dir = resolveForkRepoDir({ env: {}, homedir: "/home/pedro" });

		expect(dir).toBe("/home/pedro/Documents/Projects/oh-my-vacpi");
	});

	it("honors OMP_VACPI_REPO_DIR over the default", () => {
		const dir = resolveForkRepoDir({ env: { OMP_VACPI_REPO_DIR: "/srv/forks/vacpi" }, homedir: "/home/pedro" });

		expect(dir).toBe("/srv/forks/vacpi");
	});
});
