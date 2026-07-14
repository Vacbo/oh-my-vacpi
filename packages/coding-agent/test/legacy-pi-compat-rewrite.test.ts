import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { truncateHead } from "@oh-my-pi/pi-coding-agent";
import { TempDir } from "@oh-my-pi/pi-utils";
import { loadLegacyPiModule } from "../src/extensibility/plugins/legacy-pi-compat";

describe("legacy Pi plugin compatibility loader", () => {
	let tempDir: TempDir | undefined;

	afterEach(() => {
		tempDir?.removeSync();
		tempDir = undefined;
	});

	it("rewrites legacy scoped pi-coding-agent imports before loading a mirrored plugin file", async () => {
		tempDir = TempDir.createSync("@pi-legacy-import-rewrite-");
		const entry = path.join(tempDir.path(), "index.ts");
		await Bun.write(
			entry,
			[
				'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
				'import { formatSize as legacyFormatSize, truncateHead as legacyTruncateHead } from "@earendil-works/pi-coding-agent";',
				"export const formatted = legacyFormatSize(1536);",
				"export const sameHelper = legacyTruncateHead === globalThis.__expectedTruncateHead;",
				"export default function(_pi: ExtensionAPI) {}",
			].join("\n"),
		);

		const globals = globalThis as typeof globalThis & {
			__expectedTruncateHead?: typeof truncateHead;
		};
		globals.__expectedTruncateHead = truncateHead;
		try {
			const loaded = (await loadLegacyPiModule(entry)) as { formatted: string; sameHelper: boolean };

			// The legacy package root serves `formatBytes as formatSize` (see
			// legacy-pi-coding-agent-shim.ts and collectBundledPiEntries), so legacy
			// extensions get the compact "1.5KB" form — a stable observable contract,
			// distinct from the current root's spaced formatSize ("1.5 KB").
			expect(loaded.formatted).toBe("1.5KB");
			expect(loaded.sameHelper).toBe(true);
		} finally {
			delete globals.__expectedTruncateHead;
		}
	});
});
