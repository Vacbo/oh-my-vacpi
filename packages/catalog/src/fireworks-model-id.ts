const FIREWORKS_MODEL_WIRE_PREFIX = "accounts/fireworks/models/";
const FIREWORKS_ROUTER_PUBLIC_PREFIX = "routers/";
const FIREWORKS_ROUTER_WIRE_PREFIX = "accounts/fireworks/routers/";
const FIREPASS_WIRE_PREFIX = FIREWORKS_ROUTER_WIRE_PREFIX;
const VERSION_SEPARATOR_PATTERN = /(?<=\d)p(?=\d)/g;
const VERSION_DOT_PATTERN = /(?<=\d)\.(?=\d)/g;

export function toFireworksPublicModelId(modelId: string): string {
	const stripped = modelId.startsWith(FIREWORKS_MODEL_WIRE_PREFIX)
		? modelId.slice(FIREWORKS_MODEL_WIRE_PREFIX.length)
		: modelId.startsWith(FIREWORKS_ROUTER_WIRE_PREFIX)
			? `${FIREWORKS_ROUTER_PUBLIC_PREFIX}${modelId.slice(FIREWORKS_ROUTER_WIRE_PREFIX.length)}`
			: modelId;
	return stripped.replace(VERSION_SEPARATOR_PATTERN, ".");
}

export function toFireworksWireModelId(modelId: string): string {
	if (modelId.startsWith(FIREWORKS_MODEL_WIRE_PREFIX) || modelId.startsWith(FIREWORKS_ROUTER_WIRE_PREFIX)) {
		return modelId.replace(VERSION_DOT_PATTERN, "p");
	}
	if (modelId.startsWith(FIREWORKS_ROUTER_PUBLIC_PREFIX)) {
		const routerId = modelId.slice(FIREWORKS_ROUTER_PUBLIC_PREFIX.length);
		return `${FIREWORKS_ROUTER_WIRE_PREFIX}${routerId.replace(VERSION_DOT_PATTERN, "p")}`;
	}
	return `${FIREWORKS_MODEL_WIRE_PREFIX}${modelId.replace(VERSION_DOT_PATTERN, "p")}`;
}

/**
 * Fire Pass exposes its Kimi K2.6 Turbo subscription through a dedicated router
 * endpoint at `accounts/fireworks/routers/<id>` rather than the `models/` namespace.
 * We keep a friendly public id (e.g. `kimi-k2.6-turbo`) in the catalog and translate
 * to the wire form (`accounts/fireworks/routers/kimi-k2p6-turbo`) at request time.
 */
export function toFirepassPublicModelId(modelId: string): string {
	const stripped = modelId.startsWith(FIREPASS_WIRE_PREFIX) ? modelId.slice(FIREPASS_WIRE_PREFIX.length) : modelId;
	return stripped.replace(VERSION_SEPARATOR_PATTERN, ".");
}

export function toFirepassWireModelId(modelId: string): string {
	const stripped = modelId.startsWith(FIREPASS_WIRE_PREFIX) ? modelId.slice(FIREPASS_WIRE_PREFIX.length) : modelId;
	return `${FIREPASS_WIRE_PREFIX}${stripped.replace(VERSION_DOT_PATTERN, "p")}`;
}
