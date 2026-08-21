import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FIREPASS_SELECTOR, LEGACY_FIREPASS_SELECTOR } from "@oh-my-pi/pi-coding-agent/config/firepass-selector";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

/**
 * Fire Pass selectors persisted before it became its own provider must be
 * canonicalized when settings load — in memory for this process AND on disk, so
 * an external reader (or the next launch) never resolves the dead selector.
 */
describe("legacy Fire Pass selector settings migration", () => {
	const originalAgentDir = getAgentDir();

	afterEach(() => {
		setAgentDir(originalAgentDir);
		resetSettingsForTest();
	});

	it("canonicalizes and rewrites global and project selectors on load", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-firepass-settings-"));
		const project = TempDir.createSync("@pi-firepass-project-");
		try {
			setAgentDir(agentDir);
			fs.writeFileSync(
				path.join(agentDir, "config.yml"),
				YAML.stringify({
					modelRoles: { default: `${LEGACY_FIREPASS_SELECTOR}:high`, smol: "anthropic/claude-haiku-4-5" },
					retry: { fallbackChains: { [LEGACY_FIREPASS_SELECTOR]: [LEGACY_FIREPASS_SELECTOR, "openai/gpt-5.2"] } },
				}),
			);
			const projectConfigPath = path.join(project.path(), ".omp", "config.yml");
			fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
			fs.writeFileSync(projectConfigPath, YAML.stringify({ modelRoles: { slow: LEGACY_FIREPASS_SELECTOR } }));

			const settings = await Settings.init({ cwd: project.path(), agentDir });

			// In-memory: the thinking suffix survives, only the selector head moves.
			expect(settings.getModelRole("default")).toBe(`${FIREPASS_SELECTOR}:high`);
			expect(settings.getModelRole("smol")).toBe("anthropic/claude-haiku-4-5");
			expect(settings.getProjectModelRole("slow")).toBe(FIREPASS_SELECTOR);
			expect(settings.get("retry.fallbackChains")).toEqual({
				[FIREPASS_SELECTOR]: [FIREPASS_SELECTOR, "openai/gpt-5.2"],
			});

			// On disk: both files this instance owns are rewritten, so the legacy
			// spelling is gone for good.
			const globalText = fs.readFileSync(path.join(agentDir, "config.yml"), "utf8");
			expect(globalText).toContain(FIREPASS_SELECTOR);
			expect(globalText).not.toContain(LEGACY_FIREPASS_SELECTOR);
			const projectText = fs.readFileSync(projectConfigPath, "utf8");
			expect(projectText).toContain(FIREPASS_SELECTOR);
			expect(projectText).not.toContain(LEGACY_FIREPASS_SELECTOR);
		} finally {
			project.removeSync();
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("migrates reloaded project selectors in memory without rewriting the file", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-firepass-settings-"));
		const project = TempDir.createSync("@pi-firepass-project-");
		try {
			setAgentDir(agentDir);
			const projectConfigPath = path.join(project.path(), ".omp", "config.yml");
			fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
			const settings = await Settings.init({ cwd: project.path(), agentDir });
			const legacyProjectConfig = YAML.stringify({ modelRoles: { slow: LEGACY_FIREPASS_SELECTOR } });
			fs.writeFileSync(projectConfigPath, legacyProjectConfig);

			await settings.reloadFromDisk();

			expect(settings.getProjectModelRole("slow")).toBe(FIREPASS_SELECTOR);
			expect(fs.readFileSync(projectConfigPath, "utf8")).toBe(legacyProjectConfig);
		} finally {
			project.removeSync();
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
