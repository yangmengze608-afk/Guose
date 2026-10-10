import { z } from "zod";

export const epistemicStatusSchema = z.enum([
  "OBSERVED",
  "INFERRED",
  "UNKNOWN",
]);

export type EpistemicStatus = z.infer<typeof epistemicStatusSchema>;
