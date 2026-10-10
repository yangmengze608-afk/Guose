import { z } from "zod";

const intentItemSchema = z.string().trim().min(1).max(200);
const intentKey = (value: string): string => value.toLowerCase();
const intentListSchema = z.array(intentItemSchema).max(32).superRefine((items, context) => {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const key = intentKey(item);
    if (seen.has(key)) {
      context.addIssue({ code: "custom", path: [index], message: "Duplicate intent item." });
    }
    seen.add(key);
  });
});

export const designBriefScopeSchema = z.object({
  type: z.enum(["page", "component"]),
  targets: intentListSchema.refine((targets) => targets.length > 0, "Explicit targets are required."),
}).strict();

// Authored intent is neither repository evidence nor permission to execute a change.
export const designBriefSchema = z.object({
  goal: z.string().trim().min(1).max(2000),
  style: z.string().trim().min(1).max(100),
  keywords: intentListSchema.refine((keywords) => keywords.length > 0, "Describe the intended feel."),
  traditionalStrength: z.number().min(0).max(1),
  preserve: intentListSchema,
  modify: intentListSchema.refine((items) => items.length > 0, "At least one intended change is required."),
  avoid: intentListSchema,
  scope: designBriefScopeSchema,
  intensity: z.enum(["low", "medium", "high"]),
  allowLayoutChange: z.boolean(),
  unresolvedQuestions: intentListSchema.optional(),
}).strict().superRefine((brief, context) => {
  const groups = ["preserve", "modify", "avoid"] as const;
  for (let left = 0; left < groups.length; left += 1) {
    const leftGroup = groups[left]!;
    const leftKeys = new Set(brief[leftGroup].map(intentKey));
    for (let right = left + 1; right < groups.length; right += 1) {
      const rightGroup = groups[right]!;
      brief[rightGroup].forEach((item, index) => {
        if (leftKeys.has(intentKey(item))) {
          context.addIssue({
            code: "custom",
            path: [rightGroup, index],
            message: `Intent conflicts with ${leftGroup}; clarify before confirmation.`,
          });
        }
      });
    }
  }
  if (!brief.allowLayoutChange && brief.modify.some((item) => intentKey(item) === "layout")) {
    context.addIssue({ code: "custom", path: ["modify"], message: "Layout modification is disallowed." });
  }
  if (brief.allowLayoutChange && brief.preserve.some((item) => intentKey(item) === "layout")) {
    context.addIssue({ code: "custom", path: ["allowLayoutChange"], message: "Layout must be preserved; clarify this conflict." });
  }
});

// Vocabulary only. No confirmation state machine or operation authorization in T1.
export const designBriefDecisionSchema = z.enum(["CONFIRM", "EDIT", "CANCEL"]);

export type DesignBrief = z.infer<typeof designBriefSchema>;
export type DesignBriefScope = z.infer<typeof designBriefScopeSchema>;
export type DesignBriefDecision = z.infer<typeof designBriefDecisionSchema>;
