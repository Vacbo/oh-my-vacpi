import { afterEach, describe, expect, it } from "bun:test";
import { encodeKey, type KeyId, matchesKey, setKittyProtocolActive } from "@oh-my-pi/pi-tui/keys";

afterEach(() => setKittyProtocolActive(false));

/**
 * Every id encodeKey claims to support must round-trip through the native
 * matcher with the kitty protocol inactive (the state a tui_drive child sees).
 */
const ROUND_TRIP_IDS: KeyId[] = [
	// Unmodified named keys
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageUp",
	"pageDown",
	"up",
	"down",
	"left",
	"right",
	"f1",
	"f2",
	"f3",
	"f4",
	"f5",
	"f6",
	"f7",
	"f8",
	"f9",
	"f10",
	"f11",
	"f12",
	// Printable characters
	"a",
	"z",
	"0",
	"9",
	"[",
	"]",
	"/",
	"?",
	// Letter modifier combos
	"shift+a",
	"alt+x",
	"alt+shift+p",
	"ctrl+a",
	"ctrl+c",
	"ctrl+z",
	"ctrl+alt+a",
	"ctrl+shift+p",
	"super+a",
	// ctrl+letter combos whose raw control byte collides with a named key
	// (must take the modifyOtherKeys encoding, not the raw byte)
	"ctrl+m",
	"ctrl+i",
	"ctrl+j",
	"ctrl+h",
	"ctrl+alt+m",
	// ctrl+symbol legacy control bytes
	"ctrl+@",
	"ctrl+\\",
	"ctrl+]",
	"ctrl+^",
	"ctrl+_",
	"ctrl+-",
	"ctrl+[",
	"ctrl++",
	// Shifted non-letters (modifyOtherKeys fallback)
	"shift+1",
	"shift+/",
	// Named keys with modifiers
	"shift+tab",
	"alt+tab",
	"ctrl+tab",
	"shift+enter",
	"ctrl+enter",
	"alt+enter",
	"ctrl+space",
	"alt+space",
	"shift+space",
	"alt+backspace",
	"ctrl+backspace",
	"ctrl+shift+backspace",
	// Arrows with modifiers
	"shift+up",
	"ctrl+up",
	"alt+up",
	"alt+left",
	"ctrl+shift+left",
	"shift+alt+right",
	"super+up",
	// Home/End with modifiers
	"shift+home",
	"ctrl+end",
	"ctrl+shift+home",
	// Functional keys with modifiers
	"ctrl+delete",
	"shift+delete",
	"alt+delete",
	"shift+pageUp",
	"ctrl+pageDown",
	"shift+insert",
	"ctrl+insert",
	"shift+clear",
	"ctrl+clear",
];

describe("encodeKey", () => {
	it("round-trips through matchesKey for every supported id (legacy mode)", () => {
		setKittyProtocolActive(false);
		for (const id of ROUND_TRIP_IDS) {
			const encoded = encodeKey(id);
			expect(
				matchesKey(encoded, id),
				`matchesKey(encodeKey(${JSON.stringify(id)}), …) with ${JSON.stringify(encoded)}`,
			).toBe(true);
		}
	});

	it("emits the canonical terminal bytes for common keys", () => {
		// Downstream PTY writes depend on these exact bytes: Enter must be CR
		// (line discipline), arrows/tab the classic xterm sequences.
		expect(encodeKey("enter")).toBe("\r");
		expect(encodeKey("escape")).toBe("\x1b");
		expect(encodeKey("up")).toBe("\x1b[A");
		expect(encodeKey("shift+tab")).toBe("\x1b[Z");
		expect(encodeKey("ctrl+c")).toBe("\x03");
		expect(encodeKey("alt+x")).toBe("\x1bx");
		expect(encodeKey("backspace")).toBe("\x7f");
	});

	it("avoids raw control bytes that the matcher resolves to named keys", () => {
		// ctrl+m's raw byte is CR == Enter; the encoding must disambiguate.
		expect(encodeKey("ctrl+m")).not.toBe("\r");
		expect(matchesKey(encodeKey("ctrl+m"), "enter")).toBe(false);
		expect(matchesKey("\r", "ctrl+m")).toBe(false);
	});

	it("throws for combos with no legacy encoding", () => {
		expect(() => encodeKey("ctrl+escape")).toThrow(/no legacy encoding/);
		expect(() => encodeKey("shift+escape")).toThrow(/no legacy encoding/);
		expect(() => encodeKey("shift+f5")).toThrow(/no legacy encoding/);
		expect(() => encodeKey("alt+clear")).toThrow(/no legacy encoding/);
	});

	it("throws for unknown or modifier-only ids", () => {
		expect(() => encodeKey("bogus" as KeyId)).toThrow(/no legacy encoding/);
		expect(() => encodeKey("shift" as KeyId)).toThrow(/no legacy encoding/);
		expect(() => encodeKey("é" as KeyId)).toThrow(/no legacy encoding/);
	});
});
