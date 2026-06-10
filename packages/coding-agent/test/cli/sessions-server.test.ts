import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startSessionsServer } from "../../src/cli/sessions-server";

describe("sessions-server photo mode", () => {
	test("serves the machine-readable text layer hidden", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sessions-server-test-"));
		const handle = startSessionsServer({ agentDir });
		try {
			const response = await fetch(`${handle.url}/sessions?run=does-not-exist&mode=photo`);
			expect(response.status).toBe(200);
			const html = await response.text();
			// The scrape layer must exist for DOM consumers...
			expect(html).toContain("data-terminal-text");
			// ...but must never paint: mirror screenshots capture this page fullPage, and a
			// visible sr-text block duplicates the whole screen as wrapped text above the grid.
			expect(html).toMatch(/\.sr-text\s*\{[^}]*position:\s*absolute/);
		} finally {
			handle.stop();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});
