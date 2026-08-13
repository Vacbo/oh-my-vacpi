/**
 * Skill discovery ranking.
 *
 * Under `skills.discoveryMode: "search"` the unpinned skills leave the system
 * prompt's `<skills>` listing and become a searchable corpus instead. The
 * `search_skills` tool ranks that corpus here and hands back `skill://<name>`
 * URIs — a skill match is never "activated", so this module never touches the
 * toolset.
 *
 * Ranking is BM25+ over three weighted fields (name, description, and the
 * capped SKILL.md body excerpt). It is offline and deterministic: no embedding
 * provider, no network, no per-session state.
 */

/** Wire name of the skill-search tool. Single source of truth for prompt gating. */
export const SKILL_SEARCH_TOOL_NAME = "search_skills";

/** One skill as indexed for search. */
export interface SkillSearchEntry {
	/** Skill name; also the `skill://<name>` read target handed back on a match. */
	name: string;
	/** One-line skill description, shown with every match. */
	description: string;
	/** Capped SKILL.md body excerpt. Indexed only — never rendered. */
	searchText?: string;
}

interface SkillSearchDocument {
	entry: SkillSearchEntry;
	termFrequencies: Map<string, number>;
	/** Sum of weighted term counts; the BM25 document length. */
	length: number;
}

/** Immutable corpus built from the discoverable skills of one session. */
export interface SkillSearchIndex {
	documents: SkillSearchDocument[];
	averageLength: number;
	documentFrequencies: Map<string, number>;
}

export interface SkillSearchResult {
	entry: SkillSearchEntry;
	score: number;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** BM25+ lower-bound term: keeps a rare match from scoring ~0 in a long document. */
const BM25_DELTA = 1.0;

/** Name dominates: it is what the model half-remembers. Body text is a tiebreaker. */
const FIELD_WEIGHTS = {
	name: 6,
	description: 2,
	searchText: 1,
} as const;

function tokenize(value: string): string[] {
	return (
		value
			.normalize("NFKD")
			// Drop combining marks (accents) so "café" → "cafe".
			.replace(/\p{M}+/gu, "")
			// Split ACRONYMBoundary: "MCPTool" → "MCP Tool".
			.replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
			// Split camelCase / digit→letter: "fooBar" → "foo Bar", "v2Beta" → "v2 Beta".
			.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
			// Everything that isn't a letter or digit becomes a separator. This subsumes markdown
			// punctuation (`|*_`#-~>[]()`), box-drawing glyphs (─│┌), em/en dashes, smart quotes,
			// zero-width spaces, NBSPs, etc.
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.toLowerCase()
			.trim()
			.split(/\s+/)
			.filter(token => token.length > 0)
	);
}

function addWeightedTokens(termFrequencies: Map<string, number>, value: string | undefined, weight: number): void {
	if (!value) return;
	for (const token of tokenize(value)) {
		termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + weight);
	}
}

function buildSearchDocument(entry: SkillSearchEntry): SkillSearchDocument {
	const termFrequencies = new Map<string, number>();
	addWeightedTokens(termFrequencies, entry.name, FIELD_WEIGHTS.name);
	addWeightedTokens(termFrequencies, entry.description, FIELD_WEIGHTS.description);
	addWeightedTokens(termFrequencies, entry.searchText, FIELD_WEIGHTS.searchText);
	const length = Array.from(termFrequencies.values()).reduce((sum, value) => sum + value, 0);
	return { entry, termFrequencies, length };
}

export function buildSkillSearchIndex(entries: Iterable<SkillSearchEntry>): SkillSearchIndex {
	const documents = Array.from(entries, buildSearchDocument);
	const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1;
	const documentFrequencies = new Map<string, number>();
	for (const document of documents) {
		for (const token of document.termFrequencies.keys()) {
			documentFrequencies.set(token, (documentFrequencies.get(token) ?? 0) + 1);
		}
	}
	return { documents, averageLength, documentFrequencies };
}

/**
 * Rank the corpus against a free-text query, best first.
 *
 * Throws on an unusable query (no indexable token, e.g. all punctuation) or a
 * non-positive-integer `limit`: both are caller mistakes, not empty results.
 */
export function searchSkills(index: SkillSearchIndex, query: string, limit: number): SkillSearchResult[] {
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) {
		throw new Error("Query must contain at least one letter or number.");
	}
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new Error("Limit must be a positive integer.");
	}
	if (index.documents.length === 0) return [];

	const queryTermCounts = new Map<string, number>();
	for (const token of queryTokens) {
		queryTermCounts.set(token, (queryTermCounts.get(token) ?? 0) + 1);
	}

	return index.documents
		.map(document => {
			let score = 0;
			for (const [token, queryTermCount] of queryTermCounts) {
				const termFrequency = document.termFrequencies.get(token) ?? 0;
				if (termFrequency === 0) continue;
				const documentFrequency = index.documentFrequencies.get(token) ?? 0;
				const idf = Math.log(1 + (index.documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
				const normalization = BM25_K1 * (1 - BM25_B + BM25_B * (document.length / index.averageLength));
				score +=
					queryTermCount * idf * ((termFrequency * (BM25_K1 + 1)) / (termFrequency + normalization) + BM25_DELTA);
			}
			return { entry: document.entry, score };
		})
		.filter(result => result.score > 0)
		.sort((left, right) => right.score - left.score || left.entry.name.localeCompare(right.entry.name))
		.slice(0, limit);
}
