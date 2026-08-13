/**
 * Fire Pass selector canonicalization.
 *
 * Fire Pass used to be reachable only as a model-scoped Fireworks router entry
 * (`fireworks/routers/kimi-k2.6-turbo`). It is a provider of its own now, so a
 * persisted selector naming the old entry resolves to no model at all: a resumed
 * session or a configured model role would silently fall back to something else.
 *
 * Lives in its own module so the session-entry migration, resume-selector
 * derivation, and the settings migration share one spelling without dragging
 * session or config internals into each other.
 */

/** Selector shape written by the pre-provider Fire Pass path. */
export const LEGACY_FIREPASS_SELECTOR = "fireworks/routers/kimi-k2.6-turbo";

/** Canonical Fire Pass selector. */
export const FIREPASS_SELECTOR = "firepass/kimi-k2.6-turbo";

/** Canonical form of a bare `provider/model` selector. */
export function normalizeFirePassSelector(selector: string): string {
	return selector === LEGACY_FIREPASS_SELECTOR ? FIREPASS_SELECTOR : selector;
}

/**
 * Canonical form of a persisted settings value, which may carry a thinking
 * suffix (`provider/model:high`) or an OpenRouter route suffix (`…@fireworks`).
 * Only the selector head is rewritten, so every suffix survives untouched.
 */
export function migrateFirePassSelectorValue(value: string): string {
	if (value === LEGACY_FIREPASS_SELECTOR) return FIREPASS_SELECTOR;
	if (value.startsWith(`${LEGACY_FIREPASS_SELECTOR}:`)) {
		return `${FIREPASS_SELECTOR}${value.slice(LEGACY_FIREPASS_SELECTOR.length)}`;
	}
	return value;
}
