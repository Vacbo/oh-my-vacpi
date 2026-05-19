import { type ZodOptional, type ZodRawShape, type ZodType, z } from "zod/v4";

export type TSchema = ZodType;
export type Static<T extends ZodType> = z.infer<T>;

interface Meta {
	description?: string;
	default?: unknown;
	[key: string]: unknown;
}

interface NumberOpts extends Meta {
	minimum?: number;
	maximum?: number;
}

function withMeta<T extends ZodType>(schema: T, opts: Meta | undefined): T {
	if (!opts) return schema;
	let out: ZodType = schema;
	if (typeof opts.description === "string") out = out.describe(opts.description);
	if ("default" in opts) out = out.default(opts.default as never) as unknown as ZodType;
	return out as T;
}

function string(opts?: Meta): ZodType {
	return withMeta(z.string(), opts);
}

function number(opts?: NumberOpts): ZodType {
	let schema = z.number();
	if (typeof opts?.minimum === "number") schema = schema.min(opts.minimum);
	if (typeof opts?.maximum === "number") schema = schema.max(opts.maximum);
	return withMeta(schema, opts);
}

function boolean(opts?: Meta): ZodType {
	return withMeta(z.boolean(), opts);
}

function literal(value: string | number | boolean, opts?: Meta): ZodType {
	return withMeta(z.literal(value), opts);
}

function union(schemas: readonly ZodType[], opts?: Meta): ZodType {
	if (schemas.length === 0) return withMeta(z.never(), opts);
	if (schemas.length === 1) return withMeta(schemas[0], opts);
	return withMeta(z.union(schemas as [ZodType, ZodType, ...ZodType[]]), opts);
}

function array(item: ZodType, opts?: Meta): ZodType {
	return withMeta(z.array(item), opts);
}

function object<P extends ZodRawShape>(properties: P, opts?: Meta): ZodType {
	return withMeta(z.object(properties).loose(), opts);
}

function optional<T extends ZodType>(schema: T): ZodOptional<T> {
	return schema.optional();
}

export const Type = {
	String: string,
	Number: number,
	Boolean: boolean,
	Literal: literal,
	Union: union,
	Array: array,
	Object: object,
	Optional: optional,
} as const;
