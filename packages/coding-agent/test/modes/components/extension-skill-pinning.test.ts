import { beforeAll, describe, expect, it } from "bun:test";
import { toggleSkillPinEntry } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/extension-dashboard";
import { ExtensionList } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/extension-list";
import type { Extension } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme(false);
});

const CTRL_P = "\x10";

function extension(overrides: Partial<Extension> & Pick<Extension, "id" | "kind">): Extension {
	const name = overrides.id.replace(/^[^:]+:/, "");
	return {
		name,
		displayName: name,
		path: `/tmp/${overrides.id}`,
		source: { provider: "native", providerName: "Native", level: "native" },
		state: "active",
		raw: {},
		...overrides,
	};
}

describe("toggleSkillPinEntry", () => {
	it("adds and removes literal names without touching glob patterns", () => {
		const withPin = toggleSkillPinEntry(["cmux*"], "caveman");
		expect(withPin).toEqual(["cmux*", "caveman"]);
		expect(toggleSkillPinEntry(withPin, "caveman")).toEqual(["cmux*"]);
	});
});

describe("ExtensionList skill pinning", () => {
	it("dispatches ctrl+p pin toggles for any extension row; kind policy lives in the callback", () => {
		const skill = extension({ id: "skill:caveman", kind: "skill" });
		const tool = extension({ id: "tool:hasher", kind: "tool" });
		const toggled: string[] = [];
		const list = new ExtensionList([skill, tool], {
			// Mirror ExtensionDashboard's policy: only skills pin there.
			onPinToggle: ext => {
				if (ext.kind === "skill") toggled.push(ext.name);
			},
		});

		// Index 0 is the "Skills" kind header; navigate onto the skill row.
		list.handleInput("\x1b[B");
		list.handleInput(CTRL_P);
		expect(toggled).toEqual(["caveman"]);

		// Move onto the tool row (kind header, then tool): the list dispatches,
		// but the kind-gated callback ignores it (ToolsDashboard opts tools in).
		list.handleInput("\x1b[B");
		list.handleInput("\x1b[B");
		list.handleInput(CTRL_P);
		expect(toggled).toEqual(["caveman"]);
	});

	it("renders the pinned badge from the isPinned callback", () => {
		const pinnedSkill = extension({ id: "skill:caveman", kind: "skill" });
		const plainSkill = extension({ id: "skill:database", kind: "skill" });
		const list = new ExtensionList([pinnedSkill, plainSkill], {
			isPinned: ext => ext.name === "caveman",
		});

		const rendered = list.render(120).join("\n");
		const pinnedLine = rendered.split("\n").find(line => line.includes("caveman"));
		const plainLine = rendered.split("\n").find(line => line.includes("database"));
		expect(pinnedLine).toContain("(pinned)");
		expect(plainLine).not.toContain("(pinned)");
	});
});
