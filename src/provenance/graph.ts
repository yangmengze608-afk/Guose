import type {
  EvidenceReference,
  ProvenanceEdge,
  ProvenanceGraph,
  SourceLocation,
} from "../schemas/index.js";
import { hashContent } from "../utils/content-hash.js";

interface LocatedRecord {
  readonly id: string;
  readonly source?: SourceLocation | undefined;
  readonly contextEvidenceIds?: readonly string[] | undefined;
}

interface InferenceRecord {
  readonly id: string;
  readonly evidence: readonly EvidenceReference[];
}

interface UnknownRecord extends LocatedRecord {
  readonly relatedEvidenceIds: readonly string[];
}

export interface ProvenanceInput {
  readonly observations: readonly LocatedRecord[];
  readonly inferences: readonly InferenceRecord[];
  readonly unknowns: readonly UnknownRecord[];
}

function sourceKey(source: SourceLocation): string {
  return source.type === "FILE"
    ? `FILE\u0000${source.file}`
    : [
        "SPAN",
        source.file,
        source.startLine,
        source.startColumn,
        source.endLine,
        source.endColumn,
      ].join("\u0000");
}

function sourceId(source: SourceLocation): string {
  return `source:${hashContent(sourceKey(source))}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEdges(left: ProvenanceEdge, right: ProvenanceEdge): number {
  return (
    compareText(left.from, right.from) ||
    compareText(left.relationship, right.relationship) ||
    compareText(left.to, right.to)
  );
}

export function createProvenanceGraph(input: ProvenanceInput): ProvenanceGraph {
  const sources = new Map<string, SourceLocation>();
  const edges: ProvenanceEdge[] = [];

  for (const record of [...input.observations, ...input.unknowns]) {
    if (record.source === undefined) continue;
    const id = sourceId(record.source);
    sources.set(id, record.source);
    edges.push({ from: record.id, to: id, relationship: "LOCATED_AT" });
  }

  for (const observation of input.observations) {
    for (const contextId of observation.contextEvidenceIds ?? []) {
      edges.push({
        from: contextId,
        to: observation.id,
        relationship: "CONTEXTUALIZES",
      });
    }
  }

  for (const inference of input.inferences) {
    for (const reference of inference.evidence) {
      edges.push({
        from: reference.evidenceId,
        to: inference.id,
        relationship: reference.relationship,
      });
    }
  }

  for (const unknown of input.unknowns) {
    for (const evidenceId of unknown.relatedEvidenceIds) {
      edges.push({
        from: evidenceId,
        to: unknown.id,
        relationship: "RELATED_TO",
      });
    }
  }

  return {
    sources: [...sources.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([id, location]) => ({ id, location })),
    edges: edges.sort(compareEdges),
  };
}
