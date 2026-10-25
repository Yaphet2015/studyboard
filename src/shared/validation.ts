import { z } from "zod";

/** These limits apply at every IPC and disk boundary, not only in the editor. */
export const LIMITS = {
  boardBytes: 8 * 1024 * 1024,
  nodes: 500,
  relations: 1_000,
  notes: 200,
  noteText: 20_000,
  messagesPerNote: 200,
  contextReferences: 20,
  contextCharacters: 20_000,
  structureCharacters: 4_000,
  prompt: 8_000,
  /** Cards one generation may return: 8 for the first map, wider for an expansion (重做下层 by a learner's rule). */
  mapCards: 8,
  expansionCards: 12,
} as const;

export const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/, "Invalid identifier");
export const pointSchema = z
  .object({
    x: z.number().finite().min(-100_000).max(100_000),
    y: z.number().finite().min(-100_000).max(100_000),
  })
  .strict();
export const understandingSchema = z.enum(["unseen", "exploring", "explained"]);
export const colorSchema = z.enum(["sage", "blue", "peach", "lavender"]);
const hintAngleSchema = z.enum(["why", "how", "example", "edge", "compare", "apply"]);
const timestampSchema = z.iso.datetime({ offset: true });
const nonemptyText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, "Must not be blank");
const plainText = (max: number) =>
  nonemptyText(max).refine(
    (value) => !/<\/?[a-z][^>]*>/i.test(value) && !/```/.test(value),
    "Map content must be plain text, without HTML or code blocks",
  );
export const visualDiagramSchema = z
  .object({
    kind: z.enum(["process", "parts", "comparison"]),
    title: plainText(60).optional(),
    labels: z.array(plainText(32)).min(2).max(4),
    caption: plainText(120).optional(),
    basis: z.enum(["literal", "analogy"]),
  })
  .strict();
export const depthTypeSchema = z.enum([
  "what",
  "why",
  "how",
  "edge",
  "apply",
  "compare",
]);
const sourceUrl = z
  .string()
  .max(500)
  .refine((u) => /^https?:\/\/[^\s<>"]+$/i.test(u), "http(s) URL only");
export const cardSourceSchema = z
  .object({ title: plainText(120), url: sourceUrl.optional() })
  .strict();
/** Rich card fields, shared by stored cards and AI output. */
export const richCardFields = {
  summary: plainText(160).optional(),
  keyPoints: z.array(plainText(160)).max(4).optional(),
  whyItMatters: plainText(300).optional(),
  example: plainText(400).optional(),
  misconception: plainText(300).optional(),
  depthType: depthTypeSchema.optional(),
  sources: z.array(cardSourceSchema).max(4).optional(),
};
/**
 * Model text that names a tag in prose (“写在 <template> 里”) is kept readable with full-width
 * brackets instead of failing the map; it is plain text either way.
 */
const ACTIVE_MARKUP =
  /<\/?\s*(script|iframe|img|svg|style|object|embed|a|link|meta|form|input|video|audio|math)\b|\son\w+\s*=|javascript:/i;
const defang = (v: unknown) =>
  typeof v === "string" && !ACTIVE_MARKUP.test(v)
    ? v.replace(/</g, "＜").replace(/>/g, "＞")
    : v; // Anything that looks like active markup is still rejected by plainText.
const aiText = (max: number) => z.preprocess(defang, plainText(max));
/**
 * The same fields as the model sends them: a bad or over-long optional field is trimmed or dropped
 * instead of failing the whole map (plain-text checks still apply, so nothing unsafe is kept).
 */
const aiRichCardFields = {
  summary: aiText(160).optional().catch(undefined),
  keyPoints: z
    .preprocess(
      (v) => (Array.isArray(v) ? v.slice(0, 4) : v),
      z.array(aiText(160)).max(4).optional(),
    )
    .catch(undefined),
  whyItMatters: aiText(300).optional().catch(undefined),
  example: aiText(400).optional().catch(undefined),
  misconception: aiText(300).optional().catch(undefined),
  depthType: richCardFields.depthType.catch(undefined),
  sources: z
    .preprocess(
      (v) => (Array.isArray(v) ? v.slice(0, 4) : v),
      richCardFields.sources,
    )
    .catch(undefined),
};
export const conceptNodeSchema = z
  .object({
    id: idSchema,
    kind: z.enum(["concept", "scene"]),
    title: nonemptyText(160),
    body: z.string().max(4_000),
    parentId: idSchema.nullable(),
    order: z.number().int().min(0).max(LIMITS.nodes),
    status: understandingSchema,
    hand: z.string().max(200).optional(),
    expanded: z.boolean().optional(),
    visual: visualDiagramSchema.optional(),
    question: z.boolean().optional(),
    hints: z
      .object({
        sig: z.string().max(600),
        below: z.string().max(40).optional(),
        right: z.string().max(40).optional(),
        above: z.string().max(40).optional(),
        angles: z
          .object({
            below: hintAngleSchema.optional(),
            right: hintAngleSchema.optional(),
            above: hintAngleSchema.optional(),
          })
          .strict()
          .optional(),
        more: z
          .array(
            z.object({ angle: hintAngleSchema, text: z.string().max(40) }).strict(),
          )
          .max(2)
          .optional(),
      })
      .strict()
      .optional(),
    overview: z
      .object({ summary: plainText(120), sig: z.string().max(80) })
      .strict()
      .optional(),
    planBlock: idSchema.optional(),
    ...richCardFields,
    check: z
      .object({
        q: z.string().max(400),
        options: z.array(z.string().max(120)).max(5).optional(),
      })
      .strict()
      .optional(),
    beat: z.enum(["guess", "learn", "explain", "test", "done"]).optional(),
    fails: z.number().int().min(0).max(99).optional(),
    guess: z.string().max(2_000).optional(),
    explain: z.string().max(4_000).optional(),
    seal: z.enum(["test", "probe"]).optional(),
    analogy: z.string().max(2_000).optional(),
    meta: z
      .object({
        gate: z
          .object({
            newIdea: z.string().max(200).optional(),
            substance: z
              .array(
                z
                  .object({
                    kind: z.string().max(40),
                    text: z.string().max(400),
                    isExample: z.boolean().optional(),
                    source: z.string().max(400).optional(),
                  })
                  .strict(),
              )
              .max(8)
              .optional(),
            addsBeyond: z.string().max(400).optional(),
            claims: z.array(z.string().max(200)).max(6).optional(),
            simParent: z.number().min(0).max(1).optional(),
            simMax: z.number().min(0).max(1).optional(),
            decidedBy: z.enum(["cheap", "judge"]).optional(),
            judgeAdds: z.string().max(400).optional(),
            regenerated: z.boolean().optional(),
          })
          .strict()
          .optional(),
        check: z
          .object({
            keyPoints: z.array(z.string().max(200)).max(6),
            answer: z.number().int().min(0).max(5).optional(),
          })
          .strict()
          .optional(),
        missed: z.string().max(200).optional(),
        level: z.number().int().min(0).max(5).optional(),
        split: z.boolean().optional(),
        later: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
/** v1 node shape, accepted only as migration input. */
const conceptNodeV1Schema = z
  .object({
    id: idSchema,
    kind: z.enum(["concept", "scene"]),
    title: nonemptyText(160),
    body: z.string().max(4_000),
    emoji: z.string().max(32),
    position: pointSchema,
    color: colorSchema,
    status: understandingSchema,
    expanded: z.boolean().optional(),
    visual: visualDiagramSchema.optional(),
  })
  .strict();
export const relationSchema = z
  .object({
    id: idSchema,
    source: idSchema,
    target: idSchema,
    label: z.string().max(200),
    kind: z.literal("cross"),
  })
  .strict();
export const canvasArchiveSchema = z
  .object({
    id: idSchema,
    runId: idSchema,
    reason: z.string().min(1).max(500),
    node: conceptNodeSchema,
    relations: z.array(relationSchema).max(LIMITS.relations),
    children: z
      .array(conceptNodeSchema.pick({ id: true, parentId: true, order: true }))
      .max(LIMITS.nodes)
      .optional(),
    noteBindings: z
      .array(
        z
          .object({
            id: idSchema,
            attachedTo: z
              .object({ kind: z.enum(["node", "relation"]), id: idSchema })
              .optional(),
            contextCards: z.array(idSchema).optional(),
          })
          .strict(),
      )
      .max(LIMITS.notes),
    mergedInto: idSchema.optional(),
    createdAt: timestampSchema,
  })
  .strict();
const relationV1Schema = z
  .object({
    id: idSchema,
    source: idSchema,
    target: idSchema,
    label: z.string().max(200),
  })
  .strict();
const probeVerdictSchema = z.enum(["correct", "partial", "wrong", "unsure"]);
export const probeStateSchema = z
  .object({
    status: z.enum(["asking", "done", "skipped"]),
    ladder: z
      .array(
        z
          .object({
            level: z.number().int().min(0).max(39),
            id: z.string().max(16).optional(),
            buildsOn: z.string().max(16).optional(),
            desc: z.string().max(80),
            keyPoints: z.array(z.string().max(120)).max(3),
            probe: z
              .object({
                type: z.enum(["choice", "explain"]),
                q: z.string().max(400),
                options: z.array(z.string().max(160)).max(4).optional(),
                answer: z.number().int().min(0).max(3).optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(40),
    answers: z
      .array(
        z
          .object({
            level: z.number().int().min(0).max(39),
            pointId: z.string().max(16).optional(),
            verdict: probeVerdictSchema,
            text: z.string().max(1_000).optional(),
            missing: z.string().max(80).optional(),
            recheck: z.boolean().optional(),
          })
          .strict(),
      )
      .max(16),
    frontier: z.number().int().min(0).max(39).optional(),
    meta: z
      .object({
        expansions: z.number().int().min(0).max(10),
        refines: z.number().int().min(0).max(10),
        refined: z.array(z.string().max(40)).max(20),
        adjacent: z.array(z.string().max(40)).max(20),
        stopReason: z.enum(["precise+wrong3", "precise+idk", "precise", "idk", "skip", "cap"]).optional(),
        tokens: z.object({ gen: z.number().min(0), grade: z.number().min(0) }).strict().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const stopNo = z.number().int().min(0).max(LIMITS.nodes);
export const routeOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), title: z.string().trim().min(1).max(80), after: stopNo }).strict(),
  z.object({ op: z.literal("remove"), stop: stopNo }).strict(),
  z.object({ op: z.literal("move"), stop: stopNo, to: stopNo }).strict(),
  z.object({ op: z.literal("replace"), stop: stopNo, title: z.string().trim().min(1).max(80) }).strict(),
  z.object({ op: z.literal("focus"), stop: stopNo, text: z.string().trim().min(1).max(200) }).strict(),
]);
const proposalStateSchema = z.enum(["pending", "applied", "undone", "cancelled", "expired"]);
export const chatProposalSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("editRoute"),
      ops: z.array(routeOpSchema).min(1).max(4),
      state: proposalStateSchema,
      rows: z
        .array(
          z
            .object({
              kind: z.enum(["keep", "replace", "remove", "add", "move", "focus"]),
              from: stopNo.optional(),
              to: stopNo.optional(),
              title: z.string().max(200),
              was: z.string().max(200).optional(),
              focus: z.string().max(200).optional(),
              archives: z.boolean().optional(),
              nodeId: idSchema.optional(),
            })
            .strict(),
        )
        .max(LIMITS.nodes)
        .optional(),
    })
    .strict(),
  z.object({ type: z.literal("startStop"), stop: stopNo, stopId: idSchema, state: proposalStateSchema }).strict(),
  z
    .object({
      type: z.literal("reExpand"),
      targetId: idSchema,
      title: z.string().max(200),
      instruction: z.string().trim().min(1).max(200),
      replaces: z.number().int().min(0).max(LIMITS.nodes),
      below: z.number().int().min(0).max(LIMITS.nodes),
      added: z.number().int().min(0).max(LIMITS.nodes).optional(),
      state: proposalStateSchema,
    })
    .strict(),
]);
export const chatMessageSchema = z
  .object({
    id: idSchema,
    role: z.enum(["user", "assistant"]),
    text: z.string().max(32_000),
    createdAt: timestampSchema,
    meta: z
      .object({
        checked: z.array(z.number().int().min(0).max(50)).max(50).optional(),
        laid: z.boolean().optional(),
        chat: z.boolean().optional(),
        proposal: chatProposalSchema.optional(),
        savedNote: idSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const attachmentSchema = z
  .object({ kind: z.enum(["node", "relation"]), id: idSchema })
  .strict();
export const stickyNoteSchema = z
  .object({
    id: idSchema,
    title: z.string().max(160),
    text: z.string().max(LIMITS.noteText),
    position: pointSchema,
    attachedTo: attachmentSchema.optional(),
    messages: z.array(chatMessageSchema).max(LIMITS.messagesPerNote),
    excludedRefs: z.array(z.string().max(200)).max(100).optional(),
    contextCards: z.array(idSchema).max(LIMITS.contextReferences).optional(),
    createdAt: timestampSchema.optional(),
    /** Set on a 批注卡 made from a legacy 我的笔记 text; the source note's id. */
    meta: z.object({ migratedFrom: idSchema.optional() }).strict().optional(),
  })
  .strict();
export const sceneSchema = z
  .object({
    width: z.number().finite().min(80).max(600),
    color: z.string().regex(/^#[\da-fA-F]{6}$/),
    prediction: z.string().max(2_000),
    explanation: z.string().max(4_000),
    changed: z.enum(["width", "color"]).nullable(),
  })
  .strict();
const viewportSchema = z
  .object({
    x: z.number().finite().min(-1_000_000).max(1_000_000),
    y: z.number().finite().min(-1_000_000).max(1_000_000),
    zoom: z.number().finite().min(0.05).max(4),
  })
  .strict();
const legacyBoardV1Schema = z
  .object({
    version: z.literal(1),
    id: idSchema,
    title: nonemptyText(160),
    topic: nonemptyText(2_000),
    kind: z.enum(["walkthrough", "ai"]),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    nodes: z.array(conceptNodeV1Schema).max(LIMITS.nodes),
    relations: z.array(relationV1Schema).max(LIMITS.relations),
    notes: z.array(stickyNoteSchema).max(LIMITS.notes),
    scene: sceneSchema,
    viewport: viewportSchema.optional(),
  })
  .strict();
export const planIntentSchema = z.enum([
  "concept",
  "mechanism",
  "decision",
  "howto",
  "learning-path",
  "compare",
]);
export const planBlockSchema = z
  .object({
    id: idSchema,
    title: nonemptyText(80),
    why: z.string().max(300),
    parent: idSchema.nullable(),
    prerequisites: z.array(idSchema).max(12),
    core: z.boolean(),
  })
  .strict();
export const boardPlanSchema = z
  .object({
    status: z.enum(["draft", "confirmed"]),
    intent: planIntentSchema,
    goal: z.string().max(400),
    learner: z.string().max(400),
    blocks: z.array(planBlockSchema).max(16),
    outOfScope: z.array(z.string().max(80)).max(8),
  })
  .strict();
export const boardSchema = z
  .object({
    version: z.literal(3),
    id: idSchema,
    title: nonemptyText(160),
    topic: nonemptyText(2_000),
    kind: z.enum(["walkthrough", "ai"]),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    archivedAt: timestampSchema.optional(),
    sessionCount: z.number().int().min(0).optional(),
    progress: z
      .object({ sealed: z.number().int().min(0), total: z.number().int().min(0), done: z.boolean() })
      .strict()
      .optional(),
    canvasVersion: idSchema.optional(),
    appliedCanvasRuns: z.array(idSchema).max(1000).optional(),
    cardArchives: z.array(canvasArchiveSchema).max(1000).optional(),
    nodes: z.array(conceptNodeSchema).max(LIMITS.nodes),
    relations: z.array(relationSchema).max(LIMITS.relations),
    notes: z.array(stickyNoteSchema).max(LIMITS.notes),
    scene: sceneSchema,
    viewport: viewportSchema.optional(),
    plan: boardPlanSchema.optional(),
    route: z.array(idSchema).max(LIMITS.nodes).optional(),
    probe: probeStateSchema.optional(),
    wrap: z
      .object({
        text: z.string().max(4_000),
        lit: z.array(idSchema).max(LIMITS.nodes),
        missing: z.string().max(400).optional(),
        done: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((board, ctx) => {
    const byId = new Map(board.nodes.map((node) => [node.id, node]));
    const roots = board.nodes.filter((node) => node.parentId === null);
    // One or more top-level cards: a root can grow a broader parent above it or
    // further roots beside it (a forest). Older single-root boards are unchanged.
    if (board.nodes.length && roots.length < 1)
      ctx.addIssue({
        code: "custom",
        path: ["nodes"],
        message: "A board needs at least one root question",
      });
    board.nodes.forEach((node, index) => {
      if (node.parentId !== null && !byId.has(node.parentId)) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", index, "parentId"],
          message: "Parent does not exist",
        });
        return;
      }
      let cursor = node.parentId;
      for (let steps = 0; cursor !== null; steps += 1) {
        if (cursor === node.id || steps > board.nodes.length) {
          ctx.addIssue({
            code: "custom",
            path: ["nodes", index, "parentId"],
            message: "Parent chain contains a cycle",
          });
          return;
        }
        cursor = byId.get(cursor)?.parentId ?? null;
      }
    });
    const ids = new Set<string>();
    for (const [type, entries] of [
      ["nodes", board.nodes],
      ["relations", board.relations],
      ["notes", board.notes],
    ] as const) {
      entries.forEach((entry, index) => {
        if (ids.has(entry.id))
          ctx.addIssue({
            code: "custom",
            path: [type, index, "id"],
            message: "Duplicate board identifier",
          });
        ids.add(entry.id);
      });
    }
    const nodeIds = new Set(board.nodes.map((node) => node.id));
    const relationIds = new Set(board.relations.map((relation) => relation.id));
    board.relations.forEach((relation, index) => {
      if (!nodeIds.has(relation.source) || !nodeIds.has(relation.target)) {
        ctx.addIssue({
          code: "custom",
          path: ["relations", index],
          message: "Relation endpoint does not exist",
        });
      }
      if (relation.source === relation.target)
        ctx.addIssue({
          code: "custom",
          path: ["relations", index],
          message: "A relation must connect different nodes",
        });
    });
    board.notes.forEach((note, index) => {
      if (
        note.attachedTo &&
        !(note.attachedTo.kind === "node" ? nodeIds : relationIds).has(
          note.attachedTo.id,
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["notes", index, "attachedTo"],
          message: "Note attachment does not exist",
        });
      }
      const messageIds = new Set<string>();
      note.messages.forEach((message, messageIndex) => {
        if (messageIds.has(message.id))
          ctx.addIssue({
            code: "custom",
            path: ["notes", index, "messages", messageIndex, "id"],
            message: "Duplicate message identifier",
          });
        messageIds.add(message.id);
      });
    });
  });
export const boardSummarySchema = z
  .object({
    id: idSchema,
    title: nonemptyText(160),
    kind: z.enum(["walkthrough", "ai"]),
    updatedAt: timestampSchema,
  })
  .strict();
export const contextReferenceSchema = z
  .object({
    id: idSchema,
    kind: z.enum(["topic", "node", "relation", "note"]),
    title: z.string().max(160),
    text: z.string().max(3_000),
  })
  .strict();
export const contextBundleSchema = z
  .object({
    topic: z.string().max(2_000),
    references: z.array(contextReferenceSchema).max(LIMITS.contextReferences),
    summary: z.string().max(LIMITS.contextCharacters),
    structure: z.string().max(LIMITS.structureCharacters).optional(),
    plan: z.string().max(8_000).optional(),
    review: z
      .object({
        scope: z.literal("all").optional(),
        relations: z.array(relationSchema).max(LIMITS.relations).optional(),
        radius: z.literal(4),
        anchors: z.array(idSchema).max(LIMITS.nodes),
        nodes: z
          .array(
            conceptNodeSchema
              .pick({
                id: true,
                parentId: true,
                order: true,
                title: true,
                body: true,
                visual: true,
                summary: true,
                keyPoints: true,
                whyItMatters: true,
                example: true,
                misconception: true,
                depthType: true,
              })
              .extend({
                level: z
                  .number()
                  .int()
                  .min(0)
                  .max(LIMITS.nodes - 1),
                bodyExcluded: z.boolean().optional(),
              }),
          )
          .max(LIMITS.nodes),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (context) =>
      context.references.reduce(
        (sum, item) => sum + item.text.length + item.title.length,
        context.topic.length,
      ) <= LIMITS.contextCharacters,
    "Context is too large",
  );
export const aiRequestSchema = z
  .object({
    boardId: idSchema,
    stickyId: idSchema,
    requestId: idSchema,
    prompt: nonemptyText(LIMITS.prompt),
    context: contextBundleSchema,
    canvas: z.boolean().optional(),
    canvasRunId: idSchema.optional(),
    excludedCardIds: z.array(idSchema).max(LIMITS.nodes).optional(),
    mode: z.enum([
      "answer",
      "map",
      "expand",
      "hint",
      "organize",
      "enrich",
      "plan",
      "gate",
      "mark",
      "probe",
      "regen",
      "chat",
    ]),
  })
  .strict();
export const baseUrlSchema = z
  .string()
  .max(2_048)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      return (
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.protocol === "https:" || (url.protocol === "http:" && local))
      );
    } catch {
      return false;
    }
  }, "Use HTTPS, or HTTP on localhost, without credentials, query parameters, or fragments");
export const settingsSchema = z
  .object({
    model: nonemptyText(160).refine(
      (value) => !/[\r\n\u0000]/.test(value),
      "Invalid model name",
    ),
    baseUrl: baseUrlSchema,
    customInstructions: z
      .string()
      .max(8_000)
      .refine(
        (value) => !value.includes("\u0000"),
        "Invalid custom instructions",
      )
      .optional(),
    deepseekApiKey: z
      .string()
      .max(4_096)
      .refine((value) => !/[\r\n\u0000]/.test(value), "Invalid API key")
      .optional(),
    apiKey: z
      .string()
      .max(4_096)
      .refine((value) => !/[\r\n\u0000]/.test(value), "Invalid API key")
      .optional(),
  })
  .strict();
export const aiSettingsInputSchema = settingsSchema;
export const selectionSchema = z
  .object({ kind: z.enum(["node", "relation", "note"]), id: idSchema })
  .strict()
  .nullable();

// An invalid optional summary must not discard otherwise valid new cards.
export const aiOverviewsSchema = z
  .array(z.object({ id: idSchema, summary: plainText(120) }).strict())
  .max(12)
  .optional()
  .catch(undefined);

const mapSchema = (maxCards: number) => z
  .object({
    nodes: z
      .array(
        z
          .object({
            id: idSchema,
            title: plainText(100),
            body: aiText(1_200),
            /** "anchor", an existing card id, a generated id, or null for a root. */
            parent: idSchema.nullable().optional(),
            emoji: z.string().max(16).optional(),
            color: colorSchema.optional(),
            visual: visualDiagramSchema.optional(),
            /** The plan block this card realises. */
            block: idSchema.optional(),
            ...aiRichCardFields,
          })
          .strict(),
      )
      .min(1)
      .max(maxCards),
    relations: z
      .array(
        z
          .object({
            source: idSchema,
            target: idSchema,
            label: plainText(120),
          })
          .strict(),
      )
      .max(12)
      // A map without relations is still a map.
      .default([]),
    overviews: aiOverviewsSchema,
  })
  // Stray top-level notes (e.g. "relations_note") are dropped rather than failing the whole map;
  // nodes and relations stay strict.
  .strip();
export const aiMapSchema = mapSchema(LIMITS.mapCards);

// Expansion may find no useful additions; initial maps must still contain nodes.
export const aiExpansionSchema = z.union([
  mapSchema(LIMITS.expansionCards),
  z
    .object({
      nodes: z.tuple([]),
      relations: z.tuple([]),
      overviews: aiOverviewsSchema,
    })
    .strict(),
]);

type EdgeLike = { id: string; source: string; target: string; label: string };
/**
 * Turn a directed graph into a tree: each node keeps its first incoming edge
 * (in array order) that does not create a cycle; nodes without one hang under
 * the root. Children are ordered by `xOf` (old position.x). Unused edges are
 * returned as cross-links.
 */
export function treeify(
  ids: string[],
  edges: EdgeLike[],
  rootId: string,
  xOf: (id: string) => number,
): {
  parent: Map<string, string | null>;
  order: Map<string, number>;
  cross: EdgeLike[];
} {
  const known = new Set(ids);
  const parent = new Map<string, string | null>([[rootId, null]]);
  const used = new Set<string>();
  const isAncestor = (candidate: string, of: string) => {
    for (let c: string | null | undefined = of; c; c = parent.get(c))
      if (c === candidate) return true;
    return false;
  };
  for (const id of ids) {
    if (id === rootId) continue;
    const edge = edges.find(
      (e) =>
        e.target === id &&
        e.source !== id &&
        known.has(e.source) &&
        !isAncestor(id, e.source),
    );
    parent.set(id, edge ? edge.source : rootId);
    if (edge) used.add(edge.id);
  }
  const order = new Map<string, number>();
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const p = parent.get(id);
    if (p) groups.set(p, [...(groups.get(p) ?? []), id]);
  }
  for (const kids of groups.values())
    kids
      .map((id, index) => ({ id, index }))
      .sort((a, b) => xOf(a.id) - xOf(b.id) || a.index - b.index)
      .forEach(({ id }, index) => order.set(id, index));
  order.set(rootId, 0);
  const pairs = new Set<string>();
  const cross = edges.filter((e) => {
    const key = `${e.source}:${e.target}`;
    const keep =
      !used.has(e.id) &&
      e.source !== e.target &&
      known.has(e.source) &&
      known.has(e.target) &&
      !pairs.has(key);
    pairs.add(key);
    return keep;
  });
  return { parent, order, cross };
}

/**
 * v1 → v2: position/color/emoji are dropped; the first incoming relation of
 * each node becomes its parent (siblings ordered by old position.x) and every
 * other relation becomes a `cross` link.
 */
/**
 * v2 has v3's shape; it may still carry legacy 我的笔记 text. Validate it with the v3
 * schema (refinements included) and let migrateNoteText move that text.
 */
const parseV2 = (input: unknown) =>
  boardSchema.parse({ ...(input as object), version: 3 });

/** v1 → v2 shape (validated as v3; parseBoard then runs migrateNoteText). */
export function migrateV1toV2(input: unknown): z.infer<typeof boardSchema> {
  const v1 = legacyBoardV1Schema.parse(input);
  const nodes = [...v1.nodes];
  const relations = [...v1.relations];
  if (!nodes.length)
    nodes.push({
      id: "root-" + v1.id.slice(-80).replace(/^[^A-Za-z0-9]+/, ""),
      kind: "concept",
      title: v1.topic.slice(0, 160),
      body: "",
      emoji: "",
      position: { x: 0, y: 0 },
      color: "sage",
      status: "unseen",
    });
  const incoming = new Set(relations.map((r) => r.target));
  const candidates = nodes.filter((n) => !incoming.has(n.id));
  const root = (candidates.length ? candidates : nodes).reduce((best, n) =>
    n.position.y < best.position.y ? n : best,
  );
  const pos = new Map(nodes.map((n) => [n.id, n.position.x]));
  const { parent, order, cross } = treeify(
    nodes.map((n) => n.id),
    relations,
    root.id,
    (id) => pos.get(id) ?? 0,
  );
  const notes = v1.notes.map((note) => {
    if (
      note.attachedTo?.kind === "relation" &&
      !cross.some((r) => r.id === note.attachedTo!.id)
    ) {
      // The relation became a tree edge; attach the note to its child node.
      const edge = relations.find((r) => r.id === note.attachedTo!.id);
      return edge
        ? { ...note, attachedTo: { kind: "node" as const, id: edge.target } }
        : note;
    }
    return note;
  });
  return boardSchema.parse({
    ...v1,
    version: 3,
    nodes: nodes.map(({ emoji: _e, position: _p, color: _c, ...rest }) => ({
      ...rest,
      parentId: parent.get(rest.id) ?? null,
      order: order.get(rest.id) ?? 0,
    })),
    relations: cross.map((r) => ({ ...r, kind: "cross" as const })),
    notes,
  });
}

/**
 * v2 → v3: the right panel's 我的笔记 field is gone. Each note with non-empty text gets a
 * 批注卡 beside it (same anchor and position, title 我的笔记, the text as its body) marked
 * meta.migratedFrom, and the text is cleared. Idempotent: a note that already has a
 * migrated 批注卡 never gets a second one, and running it on v3 data changes nothing.
 */
export function migrateNoteText(
  board: z.infer<typeof boardSchema>,
): z.infer<typeof boardSchema> {
  const done = new Set(
    board.notes.flatMap((n) => (n.meta?.migratedFrom ? [n.meta.migratedFrom] : [])),
  );
  const ids = new Set(board.notes.map((n) => n.id));
  const notes: z.infer<typeof stickyNoteSchema>[] = [];
  for (const note of board.notes) {
    const text = note.text.trim();
    if (!text) {
      notes.push(note);
      continue;
    }
    if (done.has(note.id)) {
      notes.push({ ...note, text: "" });
      continue;
    }
    // A full board keeps the old text rather than lose a note.
    // ids holds every note the board will have, so it counts toward the limit.
    if (ids.size >= LIMITS.notes) {
      notes.push(note);
      continue;
    }
    notes.push({ ...note, text: "" });
    let id = `${note.id.slice(0, 85)}-migrated`;
    for (let i = 2; ids.has(id); i += 1) id = `${note.id.slice(0, 80)}-migrated${i}`;
    ids.add(id);
    done.add(note.id);
    const createdAt = note.createdAt ?? board.updatedAt;
    notes.push({
      id,
      title: "我的笔记",
      text: "",
      position: { x: note.position.x + 24, y: note.position.y + 24 },
      ...(note.attachedTo ? { attachedTo: { ...note.attachedTo } } : {}),
      messages: [
        { id: `${id.slice(0, 90)}-body`, role: "user", text, createdAt },
      ],
      createdAt,
      meta: { migratedFrom: note.id },
    });
  }
  return boardSchema.parse({
    ...board,
    version: 3,
    notes,
  });
}

/** Validate a board from disk/IPC, upgrading v1/v2 data on the way in. */
export function parseBoard(input: unknown) {
  const version = (input as { version?: unknown } | null)?.version;
  if (version === 1) return migrateNoteText(migrateV1toV2(input));
  if (version === 2) return migrateNoteText(parseV2(input));
  return boardSchema.parse(input);
}
export const safeParseBoard = (input: unknown) => {
  try {
    return { success: true as const, data: parseBoard(input) };
  } catch (error) {
    return { success: false as const, error };
  }
};

/** A whole-board revision must account for every existing card. */
export const aiOrganizationSchema = z
  .object({
    nodes: z
      .array(
        conceptNodeSchema.pick({
          id: true,
          parentId: true,
          order: true,
          title: true,
          body: true,
          visual: true,
        }),
      )
      .min(1)
      .max(LIMITS.nodes),
    relations: z.array(relationSchema).max(LIMITS.relations),
  })
  .strict();
