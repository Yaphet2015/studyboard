import { sourceLink } from "../shared/card-source";
import type { ConceptNode } from "../shared/types";

export function CardSourceLine({
  card,
}: {
  card: Pick<ConceptNode, "source" | "date" | "sources">;
}) {
  const source = sourceLink(card.source);
  if (!source) return null;
  return (
    <div className="srcl nodrag nopan" onClick={(e) => e.stopPropagation()}>
      <a href={source.url} target="_blank" rel="noopener noreferrer">{source.name}</a>
      {card.date ? ` · 截至 ${card.date.slice(0, 7)}` : ""}
    </div>
  );
}
