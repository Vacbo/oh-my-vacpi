/**
 * Keyboard input handling for terminal applications.
 *
 * Supports both legacy terminal sequences and Kitty keyboard protocol.
 * See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
 * Reference: https://github.com/sst/opentui/blob/7da92b4088aebfe27b9f691c04163a48821e49fd/packages/core/src/lib/parse.keypress.ts
 *
 * Symbol keys are also supported, however some ctrl+symbol combos
 * overlap with ASCII codes, e.g. ctrl+[ = ESC.
 * See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/#legacy-ctrl-mapping-of-ascii-keys
 * Those can still be * used for ctrl+shift combos
 *
 * API:
 * - matchesKey(data, keyId) - Check if input matches a key identifier
 * - parseKey(data) - Parse input and return the key identifier
 * - Key - Helper object for creating typed key identifiers
 * - setKittyProtocolActive(active) - Set global Kitty protocol state
 * - isKittyProtocolActive() - Query global Kitty protocol state
 */

import type { KeyEventType } from "@oh-my-pi/pi-natives";
import {
	matchesKey as matchesKeyNative,
	parseKey as parseKeyNative,
	parseKittySequence as parseKittySequenceNative,
} from "@oh-my-pi/pi-natives";

// =============================================================================
// Platform Detection
// =============================================================================

function isWindowsTerminalSession(): boolean {
	return (
		Boolean(process.env.WT_SESSION) && !process.env.SSH_CONNECTION && !process.env.SSH_CLIENT && !process.env.SSH_TTY
	);
}

/**
 * Raw 0x08 (BS) is ambiguous in legacy terminals.
 *
 * - Windows Terminal uses it for Ctrl+Backspace.
 * - Some legacy terminals and tmux setups send it for plain Backspace.
 *
 * Prefer explicit Kitty / CSI-u / modifyOtherKeys sequences whenever they are
 * available. Fall back to a Windows Terminal heuristic only for raw BS bytes.
 */
function matchesRawBackspace(data: string, expectedModifier: number): boolean {
	if (data === "\x7f") return expectedModifier === 0;
	if (data !== "\x08") return false;
	// On Windows Terminal, 0x08 = Ctrl+Backspace. On others, it's plain Backspace.
	return isWindowsTerminalSession() ? expectedModifier === 4 : expectedModifier === 0;
}

export { isWindowsTerminalSession, matchesRawBackspace };

// =============================================================================
// Global Kitty Protocol State
// =============================================================================

let kittyProtocolActive = false;

/**
 * Set the global Kitty keyboard protocol state.
 * Called by ProcessTerminal after detecting protocol support.
 */
export function setKittyProtocolActive(active: boolean): void {
	kittyProtocolActive = active;
}

/**
 * Query whether Kitty keyboard protocol is currently active.
 */
export function isKittyProtocolActive(): boolean {
	return kittyProtocolActive;
}

// =============================================================================
// Type-Safe Key Identifiers
// =============================================================================

type Letter =
	| "a"
	| "b"
	| "c"
	| "d"
	| "e"
	| "f"
	| "g"
	| "h"
	| "i"
	| "j"
	| "k"
	| "l"
	| "m"
	| "n"
	| "o"
	| "p"
	| "q"
	| "r"
	| "s"
	| "t"
	| "u"
	| "v"
	| "w"
	| "x"
	| "y"
	| "z";

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

type SymbolKey =
	| "`"
	| "-"
	| "="
	| "["
	| "]"
	| "\\"
	| ";"
	| "'"
	| ","
	| "."
	| "/"
	| "!"
	| "@"
	| "#"
	| "$"
	| "%"
	| "^"
	| "&"
	| "*"
	| "("
	| ")"
	| "_"
	| "+"
	| "|"
	| "~"
	| "{"
	| "}"
	| ":"
	| "<"
	| ">"
	| "?";

type SpecialKey =
	| "escape"
	| "esc"
	| "enter"
	| "return"
	| "tab"
	| "space"
	| "backspace"
	| "delete"
	| "insert"
	| "clear"
	| "home"
	| "end"
	| "pageUp"
	| "pageDown"
	| "up"
	| "down"
	| "left"
	| "right"
	| "f1"
	| "f2"
	| "f3"
	| "f4"
	| "f5"
	| "f6"
	| "f7"
	| "f8"
	| "f9"
	| "f10"
	| "f11"
	| "f12";

type BaseKey = Letter | Digit | SymbolKey | SpecialKey;
type ModifierName = "ctrl" | "shift" | "alt" | "super";

type ModifiedKeyId<Key extends string, RemainingModifiers extends ModifierName = ModifierName> = {
	[M in RemainingModifiers]: `${M}+${Key}` | `${M}+${ModifiedKeyId<Key, Exclude<RemainingModifiers, M>>}`;
}[RemainingModifiers];

/**
 * Union type of all valid key identifiers.
 * Provides autocomplete and catches typos at compile time.
 */
export type KeyId = BaseKey | ModifiedKeyId<BaseKey>;

/**
 * Typed helper for constructing key identifiers with autocomplete.
 *
 * The runtime values are just the canonical key-name strings (so `Key.enter`
 * is literally `"enter"`); the value of `Key` over a bag of magic strings is
 * that each property is typed to the exact `KeyId` literal it produces and the
 * modifier methods return precisely-typed concatenations (e.g. `Key.ctrl("c")`
 * is `"ctrl+c"`, not just `string`). This mirrors the upstream
 * `@mariozechner/pi-tui` `Key` export verbatim so plugins built against any
 * scope alias (`@mariozechner`, `@earendil-works`, `@oh-my-pi`) keep working
 * once the specifier shim remaps them to this package.
 */
export const Key = {
	escape: "escape",
	esc: "esc",
	enter: "enter",
	return: "return",
	tab: "tab",
	space: "space",
	backspace: "backspace",
	delete: "delete",
	insert: "insert",
	clear: "clear",
	home: "home",
	end: "end",
	pageUp: "pageUp",
	pageDown: "pageDown",
	up: "up",
	down: "down",
	left: "left",
	right: "right",
	f1: "f1",
	f2: "f2",
	f3: "f3",
	f4: "f4",
	f5: "f5",
	f6: "f6",
	f7: "f7",
	f8: "f8",
	f9: "f9",
	f10: "f10",
	f11: "f11",
	f12: "f12",
	backtick: "`",
	hyphen: "-",
	equals: "=",
	leftbracket: "[",
	rightbracket: "]",
	backslash: "\\",
	semicolon: ";",
	quote: "'",
	comma: ",",
	period: ".",
	slash: "/",
	exclamation: "!",
	at: "@",
	hash: "#",
	dollar: "$",
	percent: "%",
	caret: "^",
	ampersand: "&",
	asterisk: "*",
	leftparen: "(",
	rightparen: ")",
	underscore: "_",
	plus: "+",
	pipe: "|",
	tilde: "~",
	leftbrace: "{",
	rightbrace: "}",
	colon: ":",
	lessthan: "<",
	greaterthan: ">",
	question: "?",
	ctrl: <K extends BaseKey>(key: K) => `ctrl+${key}` as const,
	shift: <K extends BaseKey>(key: K) => `shift+${key}` as const,
	alt: <K extends BaseKey>(key: K) => `alt+${key}` as const,
	super: <K extends BaseKey>(key: K) => `super+${key}` as const,
	ctrlShift: <K extends BaseKey>(key: K) => `ctrl+shift+${key}` as const,
	shiftCtrl: <K extends BaseKey>(key: K) => `shift+ctrl+${key}` as const,
	ctrlAlt: <K extends BaseKey>(key: K) => `ctrl+alt+${key}` as const,
	altCtrl: <K extends BaseKey>(key: K) => `alt+ctrl+${key}` as const,
	shiftAlt: <K extends BaseKey>(key: K) => `shift+alt+${key}` as const,
	altShift: <K extends BaseKey>(key: K) => `alt+shift+${key}` as const,
	ctrlSuper: <K extends BaseKey>(key: K) => `ctrl+super+${key}` as const,
	superCtrl: <K extends BaseKey>(key: K) => `super+ctrl+${key}` as const,
	shiftSuper: <K extends BaseKey>(key: K) => `shift+super+${key}` as const,
	superShift: <K extends BaseKey>(key: K) => `super+shift+${key}` as const,
	altSuper: <K extends BaseKey>(key: K) => `alt+super+${key}` as const,
	superAlt: <K extends BaseKey>(key: K) => `super+alt+${key}` as const,
	ctrlShiftAlt: <K extends BaseKey>(key: K) => `ctrl+shift+alt+${key}` as const,
	ctrlShiftSuper: <K extends BaseKey>(key: K) => `ctrl+shift+super+${key}` as const,
} as const;

// =============================================================================
// Kitty Protocol Parsing
// =============================================================================

interface ParsedKittySequence {
	codepoint: number;
	shiftedKey?: number; // Shifted version of the key (when shift is pressed)
	baseLayoutKey?: number; // Key in standard PC-101 layout (for non-Latin layouts)
	modifier: number;
	eventType?: KeyEventType;
}

// Regex for Kitty protocol event type detection
// Matches CSI sequences with :2 (repeat) or :3 (release) event type
// Format: \x1b[...;modifier:event_type<terminator> where terminator is u, ~, or A-F/H
const KITTY_RELEASE_PATTERN = /^\x1b\[[\d:;]*:3[u~ABCDHF]$/;
const KITTY_REPEAT_PATTERN = /^\x1b\[[\d:;]*:2[u~ABCDHF]$/;
const KITTY_CSI_U_PATTERN = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?(?:;([\d:]*))?u$/;
const KITTY_MOD_SHIFT = 1;
const KITTY_MOD_ALT = 2;
const KITTY_MOD_CTRL = 4;
const KITTY_MOD_SUPER = 8;
const KITTY_MOD_NUM_LOCK = 128;
const KITTY_LOCK_MASK = 64 + KITTY_MOD_NUM_LOCK; // Caps Lock + Num Lock
const MODIFY_OTHER_KEYS_PATTERN = /^\x1b\[27;(\d+);(\d+)~$/;
const KITTY_KEYPAD_OPERATOR_TEXT: Record<number, string> = {
	57410: "/",
	57411: "*",
	57412: "-",
	57413: "+",
	57415: "=",
};
const KITTY_NUMPAD_TEXT: Record<number, string> = {
	57399: "0",
	57400: "1",
	57401: "2",
	57402: "3",
	57403: "4",
	57404: "5",
	57405: "6",
	57406: "7",
	57407: "8",
	57408: "9",
	57409: ".",
};

/**
 * Check if the input is a key release event.
 * Only meaningful when Kitty keyboard protocol with flag 2 is active.
 * Returns false if Kitty protocol is not active.
 */
export function isKeyRelease(data: string): boolean {
	// Only detect release events when Kitty protocol is active
	if (!kittyProtocolActive) {
		return false;
	}

	// Don't treat bracketed paste content as key release
	if (data.includes("\x1b[200~")) {
		return false;
	}

	// Match the full CSI sequence pattern for release events
	return KITTY_RELEASE_PATTERN.test(data);
}

/**
 * Check if the input is a key repeat event.
 * Only meaningful when Kitty keyboard protocol with flag 2 is active.
 * Returns false if Kitty protocol is not active.
 */
export function isKeyRepeat(data: string): boolean {
	// Only detect repeat events when Kitty protocol is active
	if (!kittyProtocolActive) {
		return false;
	}

	// Don't treat bracketed paste content as key repeat
	if (data.includes("\x1b[200~")) {
		return false;
	}

	// Match the full CSI sequence pattern for repeat events
	return KITTY_REPEAT_PATTERN.test(data);
}

export function parseKittySequence(data: string): ParsedKittySequence | null {
	const result = parseKittySequenceNative(data);
	if (!result) return null;
	return {
		codepoint: result.codepoint,
		shiftedKey: result.shiftedKey ?? undefined,
		baseLayoutKey: result.baseLayoutKey ?? undefined,
		modifier: result.modifier,
		eventType: result.eventType,
	};
}

function hasControlChars(data: string): boolean {
	return [...data].some(ch => {
		const code = ch.charCodeAt(0);
		return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
	});
}

function decodeKittyPrintable(data: string): string | undefined {
	const match = data.match(KITTY_CSI_U_PATTERN);
	if (!match) return undefined;

	const codepoint = Number.parseInt(match[1] ?? "", 10);
	if (!Number.isFinite(codepoint)) return undefined;

	if (match[5] === "3") return undefined;

	const shiftedKey = match[2] && match[2].length > 0 ? Number.parseInt(match[2], 10) : undefined;
	const modValue = match[4] ? Number.parseInt(match[4], 10) : 1;
	const modifier = Number.isFinite(modValue) ? modValue - 1 : 0;
	const effectiveMod = modifier & ~KITTY_LOCK_MASK;
	const supportedModifierMask = KITTY_MOD_SHIFT | KITTY_MOD_ALT | KITTY_MOD_CTRL | KITTY_MOD_SUPER;

	if (effectiveMod & ~supportedModifierMask) return undefined;
	if (effectiveMod & (KITTY_MOD_ALT | KITTY_MOD_CTRL | KITTY_MOD_SUPER)) return undefined;

	const textField = match[6];
	if (textField && textField.length > 0) {
		const codepoints = textField
			.split(":")
			.filter(Boolean)
			.map(value => Number.parseInt(value, 10))
			.filter(value => Number.isFinite(value) && value >= 32 && value !== 127);
		if (codepoints.length > 0) {
			try {
				return String.fromCodePoint(...codepoints);
			} catch {
				return undefined;
			}
		}
	}
	const keypadOperatorText = KITTY_KEYPAD_OPERATOR_TEXT[codepoint];
	if (keypadOperatorText) return keypadOperatorText;

	if (effectiveMod === 0) {
		const numpadText = KITTY_NUMPAD_TEXT[codepoint];
		if (numpadText) return numpadText;
	}

	let effectiveCodepoint = codepoint;
	if (effectiveMod & KITTY_MOD_SHIFT && typeof shiftedKey === "number") {
		effectiveCodepoint = shiftedKey;
	}

	if (effectiveCodepoint >= 0xe000 && effectiveCodepoint <= 0xf8ff) {
		return undefined;
	}

	if (!Number.isFinite(effectiveCodepoint) || effectiveCodepoint < 32 || effectiveCodepoint === 127) return undefined;

	try {
		return String.fromCodePoint(effectiveCodepoint);
	} catch {
		return undefined;
	}
}

/**
 * Extract printable text from raw terminal input.
 *
 * Handles Kitty CSI-u text-producing keys so text-entry components can treat
 * keypad digits, keypad operators, and shifted symbols the same as direct character input.
 */
export function extractPrintableText(data: string): string | undefined {
	const printable = decodePrintableKey(data);
	if (printable !== undefined) return printable;
	if (data.length === 0 || hasControlChars(data)) return undefined;
	return data;
}

interface ParsedModifyOtherKeysSequence {
	codepoint: number;
	modifier: number;
}

/**
 * Parse an xterm `modifyOtherKeys` format sequence: `CSI 27 ; modifiers ; keycode ~`.
 * Modifier values are 1-indexed in the wire format; we normalize to a 0-based bitmask.
 */
function parseModifyOtherKeysSequence(data: string): ParsedModifyOtherKeysSequence | null {
	const match = data.match(MODIFY_OTHER_KEYS_PATTERN);
	if (!match) return null;
	const modValue = Number.parseInt(match[1] ?? "", 10);
	const codepoint = Number.parseInt(match[2] ?? "", 10);
	if (!Number.isFinite(modValue) || !Number.isFinite(codepoint)) return null;
	return { codepoint, modifier: modValue - 1 };
}

/**
 * Decode an xterm modifyOtherKeys sequence into the printable character it represents.
 *
 * Only sequences with no modifiers or Shift alone produce text; Ctrl/Alt/Super combos
 * are treated as bindings, not text input.
 */
function decodeModifyOtherKeysPrintable(data: string): string | undefined {
	const parsed = parseModifyOtherKeysSequence(data);
	if (!parsed) return undefined;
	const modifier = parsed.modifier & ~KITTY_LOCK_MASK;
	if ((modifier & ~KITTY_MOD_SHIFT) !== 0) return undefined;
	if (!Number.isFinite(parsed.codepoint) || parsed.codepoint < 32 || parsed.codepoint === 127) return undefined;
	try {
		return String.fromCodePoint(parsed.codepoint);
	} catch {
		return undefined;
	}
}

/**
 * Decode terminal input into the printable character it represents.
 *
 * Tries Kitty CSI-u first, then falls back to xterm modifyOtherKeys. Returns
 * undefined for control sequences and modifier-only events.
 */
export function decodePrintableKey(data: string): string | undefined {
	return decodeKittyPrintable(data) ?? decodeModifyOtherKeysPrintable(data);
}

/**
 * Decode a Kitty CSI-u keypad sequence (numpad digits / keypad operators) into the
 * text it produces, or `undefined` for any non-keypad sequence.
 *
 * The native key matcher classifies bare numpad codepoints (those without a NumLock
 * modifier bit) as navigation keys, but terminals such as the VS Code integrated
 * terminal emit those codepoints for real digit input. Restricting the fast path to
 * keypad codepoints keeps canonical named keys (space, backspace, shifted keys, and
 * modifyOtherKeys sequences) flowing through native normalization.
 */
function decodeKittyKeypadText(data: string): string | undefined {
	const match = data.match(KITTY_CSI_U_PATTERN);
	if (!match) return undefined;
	const codepoint = Number.parseInt(match[1] ?? "", 10);
	if (!(codepoint in KITTY_NUMPAD_TEXT) && !(codepoint in KITTY_KEYPAD_OPERATOR_TEXT)) return undefined;
	return decodeKittyPrintable(data);
}

function matchesKeypadKey(data: string, keyId: KeyId): boolean | undefined {
	const printable = decodeKittyKeypadText(data);
	if (printable === undefined) return undefined;
	return printable === keyId;
}

/**
 * Match input data against a key identifier string.
 *
 * Supported key identifiers:
 * - Single keys: "escape", "tab", "enter", "backspace", "delete", "home", "end", "space"
 * - Arrow keys: "up", "down", "left", "right"
 * - Ctrl combinations: "ctrl+c", "ctrl+z", etc.
 * - Shift combinations: "shift+tab", "shift+enter"
 * - Alt combinations: "alt+enter", "alt+backspace"
 * - Combined modifiers: "shift+ctrl+p", "ctrl+alt+x"
 *
 * Use the Key helper for autocomplete: Key.ctrl("c"), Key.escape, Key.ctrlShift("p")
 *
 * @param data - Raw input data from terminal
 * @param keyId - Key identifier (e.g., "ctrl+c", "escape", Key.ctrl("c"))
 */
export function matchesKey(data: string, keyId: KeyId): boolean {
	return matchesKeypadKey(data, keyId) ?? matchesKeyNative(data, keyId, kittyProtocolActive);
}

// =============================================================================
// Key Encoding (inverse of matchesKey)
// =============================================================================

/** Legacy byte sequences for unmodified named keys (mirrors the native matcher tables). */
const ENCODE_SINGLE: Record<string, string> = {
	escape: "\x1b",
	enter: "\r",
	tab: "\t",
	space: " ",
	backspace: "\x7f",
	insert: "\x1b[2~",
	delete: "\x1b[3~",
	clear: "\x1b[E",
	home: "\x1b[H",
	end: "\x1b[F",
	pageup: "\x1b[5~",
	pagedown: "\x1b[6~",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	f1: "\x1bOP",
	f2: "\x1bOQ",
	f3: "\x1bOR",
	f4: "\x1bOS",
	f5: "\x1b[15~",
	f6: "\x1b[17~",
	f7: "\x1b[18~",
	f8: "\x1b[19~",
	f9: "\x1b[20~",
	f10: "\x1b[21~",
	f11: "\x1b[23~",
	f12: "\x1b[24~",
};

/** CSI `1;<mod><final>` final bytes for keys that accept xterm-style modifiers. */
const ENCODE_CSI_FINAL: Record<string, string> = {
	up: "A",
	down: "B",
	right: "C",
	left: "D",
	home: "H",
	end: "F",
};

/** CSI `<num>;<mod>~` numbers for functional keys that accept modifiers. */
const ENCODE_CSI_TILDE: Record<string, number> = {
	insert: 2,
	delete: 3,
	pageup: 5,
	pagedown: 6,
};

/** Legacy ctrl+symbol control bytes (mirrors the native `ctrl_symbol_to_byte`). */
const ENCODE_CTRL_SYMBOL: Record<string, number> = {
	"@": 0x00,
	"[": 0x1b,
	"\\": 0x1c,
	"]": 0x1d,
	"^": 0x1e,
	_: 0x1f,
	"-": 0x1f,
};

/**
 * Control bytes legacy terminals send for named keys (Backspace, Tab, LF, CR,
 * Escape, DEL). The matcher resolves these bytes to the named key, so combos
 * that would collide (e.g. ctrl+m -> CR) must use the modifyOtherKeys encoding.
 */
const NAMED_KEY_LEGACY_BYTES = new Set([0x08, 0x09, 0x0a, 0x0d, 0x1b, 0x7f]);

function encodeKeyError(keyId: string): Error {
	return new Error(
		`no legacy encoding for "${keyId}" (supported: printable characters, named keys like "enter"/"escape"/"up", and ctrl+/shift+/alt+ combinations)`,
	);
}

/**
 * Encode a key identifier into the byte sequence a legacy (non-kitty) terminal
 * would send for that key press — the inverse of {@link matchesKey}.
 *
 * Accepts the same grammar as `matchesKey`: named keys ("escape", "enter",
 * "up", "pageUp", "f5", …), printable characters, and `ctrl+`/`shift+`/`alt+`/
 * `super+` combinations. Combos with no byte-level representation the matcher
 * accepts in legacy mode (e.g. "ctrl+escape", modified f-keys) throw.
 *
 * The invariant `matchesKey(encodeKey(id), id) === true` holds for every id
 * this function returns a value for (with the kitty protocol inactive).
 *
 * @param keyId - Key identifier (e.g. "ctrl+c", "escape", Key.ctrl("c"))
 */
export function encodeKey(keyId: KeyId): string {
	const id = (keyId as string).trim();
	// Mirror the native parse_key_id: a trailing "++" (or bare "+") means the key is '+'.
	let prefix = id;
	let key: string | undefined;
	if (id === "+") {
		key = "+";
		prefix = "";
	} else if (id.endsWith("++")) {
		key = "+";
		prefix = id.slice(0, -2);
	}
	let shift = false;
	let alt = false;
	let ctrl = false;
	let superMod = false;
	for (const part of prefix.split("+")) {
		const p = part.trim();
		if (!p) continue;
		const lower = p.toLowerCase();
		if (lower === "ctrl") ctrl = true;
		else if (lower === "shift") shift = true;
		else if (lower === "alt") alt = true;
		else if (lower === "super") superMod = true;
		else key = p;
	}
	if (!key) throw encodeKeyError(id);

	let name = key.toLowerCase();
	if (name === "plus") name = "+";
	else if (name === "esc") name = "escape";
	else if (name === "return") name = "enter";

	const bits = (shift ? 1 : 0) | (alt ? 2 : 0) | (ctrl ? 4 : 0) | (superMod ? 8 : 0);
	const modParam = 1 + bits;
	const shiftOnly = bits === 1;
	const altOnly = bits === 2;
	const ctrlOnly = bits === 4;
	/** xterm modifyOtherKeys: CSI 27 ; modifiers ; keycode ~ (parsed by the matcher in all modes). */
	const mok = (codepoint: number) => `\x1b[27;${modParam};${codepoint}~`;

	if (name.length > 1) {
		if (bits === 0) {
			const seq = ENCODE_SINGLE[name];
			if (seq !== undefined) return seq;
			throw encodeKeyError(id);
		}
		switch (name) {
			case "escape":
				// The matcher rejects modified escape outright.
				throw encodeKeyError(id);
			case "enter":
				return altOnly ? "\x1b\r" : mok(13);
			case "tab":
				if (shiftOnly) return "\x1b[Z";
				if (altOnly) return "\x1b\t";
				return mok(9);
			case "space":
				if (ctrlOnly) return "\x00";
				if (altOnly) return "\x1b ";
				return mok(32);
			case "backspace":
				return altOnly ? "\x1b\x7f" : mok(127);
			case "clear":
				if (shiftOnly) return "\x1b[e";
				if (ctrlOnly) return "\x1bOe";
				throw encodeKeyError(id);
			default: {
				const final = ENCODE_CSI_FINAL[name];
				if (final !== undefined) return `\x1b[1;${modParam}${final}`;
				const num = ENCODE_CSI_TILDE[name];
				if (num !== undefined) return `\x1b[${num};${modParam}~`;
				// Modified f-keys and unknown names have no legacy encoding.
				throw encodeKeyError(id);
			}
		}
	}

	// Single-character keys: ASCII graphic chars only, mirroring the matcher.
	const code = name.charCodeAt(0);
	if (code < 0x21 || code > 0x7e) throw encodeKeyError(id);
	if (bits === 0) return name;
	const isLetter = name >= "a" && name <= "z";
	if (isLetter) {
		if (shiftOnly) return name.toUpperCase();
		if (altOnly) return `\x1b${name}`;
		if (bits === 3) return `\x1b${name.toUpperCase()}`; // alt+shift
		if (ctrlOnly || bits === 6) {
			// ctrl or ctrl+alt: raw control char, unless that byte is claimed by a named key.
			const ctrlCode = code - 96;
			if (!NAMED_KEY_LEGACY_BYTES.has(ctrlCode)) {
				const raw = String.fromCharCode(ctrlCode);
				return ctrlOnly ? raw : `\x1b${raw}`;
			}
		}
		return mok(code);
	}
	if (ctrlOnly) {
		const mapped = ENCODE_CTRL_SYMBOL[name];
		if (mapped !== undefined && !NAMED_KEY_LEGACY_BYTES.has(mapped)) {
			return String.fromCharCode(mapped);
		}
	}
	return mok(code);
}

/**
 * Parse terminal input and return a normalized key identifier.
 *
 * Returns key names like "escape", "ctrl+c", "shift+tab", "alt+enter".
 * Returns undefined if the input is not a recognized key sequence.
 *
 * @param data - Raw input data from terminal
 */
export function parseKey(data: string): string | undefined {
	return decodeKittyKeypadText(data) ?? parseKeyNative(data, kittyProtocolActive) ?? undefined;
}
