const FIREWORKS_MODEL_WIRE_PREFIX = "accounts/fireworks/models/";
const FIREWORKS_ROUTER_PUBLIC_PREFIX = "routers/";
const FIREWORKS_ROUTER_WIRE_PREFIX = "accounts/fireworks/routers/";
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
