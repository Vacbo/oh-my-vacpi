import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function sessionWith(overrides: Record<string, unknown>): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(overrides),
	};
}

describe("tools.disabledTools", () => {
	it("excludes disabled built-ins from the default toolset", async () => {
		const session = sessionWith({
			"find.enabled": true,
			"browser.enabled": true,
			"tools.disabledTools": ["find", "browser"],
		});
		const names = (await createTools(session)).map(tool => tool.name);
		expect(names).not.toContain("find");
		expect(names).not.toContain("browser");
		expect(names).toContain("read");
		expect(names).toContain("edit");
	});

	it("wins over an explicit tool request", async () => {
		const session = sessionWith({
			"find.enabled": true,
			"tools.disabledTools": ["find"],
		});
		const names = (await createTools(session, ["read", "find"])).map(tool => tool.name);
		expect(names).toContain("read");
		expect(names).not.toContain("find");
	});

	it("never disables hidden/internal tools", async () => {
		const session = sessionWith({
			"tools.disabledTools": ["yield"],
		});
		session.requireYieldTool = true;
		const names = (await createTools(session)).map(tool => tool.name);
		// The built-in disable list must not remove an explicitly required hidden tool.
		expect(names).toContain("yield");
	});
});
