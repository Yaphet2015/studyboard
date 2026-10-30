import type { ConceptNode } from "../shared/types";

export function CardSourceLine({
  card,
}: {
  card: Pick<ConceptNode, "source" | "date" | "sources">;
}) {
  const source = card.source || card.sources?.map((s) => s.title).join(" · ");
  if (!source) return null;
  return (
    <div className="srcl">
      {source}
      {card.date ? ` · 截至 ${card.date.slice(0, 7)}` : ""}
    </div>
  );
}
