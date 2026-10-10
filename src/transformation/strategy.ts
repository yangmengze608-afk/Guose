import { deepFreeze } from "../utils/deep-freeze.js";

export const TRANSFORMATION_TYPES = deepFreeze([
  "PAGE_BACKGROUND", "TEXT_COLOR", "ACCENT_COLOR", "BUTTON_BACKGROUND", "BUTTON_FOREGROUND",
  "BUTTON_RADIUS", "BUTTON_SHADOW", "BUTTON_BORDER", "CARD_BACKGROUND", "CARD_RADIUS",
  "CARD_SHADOW", "CARD_BORDER", "SECTION_SPACING", "COMPONENT_PADDING", "CTA_BACKGROUND",
] as const);
export type TransformationType = typeof TRANSFORMATION_TYPES[number];

// Authored design proposals, never recovered facts or probabilities. No model call.
export const modernEasternDemoStrategy = deepFreeze({
  id: "ModernEasternDemoStrategy", version: "1.0.0", source: "STYLE_STRATEGY" as const,
  compatibleStyles: ["现代、克制、有东方气质", "modern-restrained-eastern"],
  palette: { page: "#F4F4F0", text: "#262B2C", secondary: "#586465", accent: "#365E60", soft: "#E7EEEA", surface: "#FEFEFC", elevated: "#FAFBF8", border: "#D1DCD5", buttonBorder: "#BCC9C4", white: "#FFFFFF" },
  radius: { button: "8px", elevated: "16px", flat: "10px", cta: "12px" },
  shadow: { elevated: "0 2px 12px rgb(38 43 44 / 0.05)", flat: "none" },
  padding: { button: "14px 24px", elevated: "32px", flat: "32px", cta: "48px" },
  sectionSpacing: "96px",
});

export const transformationRules: ReadonlyArray<{ type: TransformationType; intent: string[]; dimensions: string[]; property: string }> = deepFreeze([
  { type: "PAGE_BACKGROUND", intent: ["page-background", "palette"], dimensions: ["palette"], property: "background-color" },
  { type: "TEXT_COLOR", intent: ["palette"], dimensions: ["palette"], property: "color" },
  { type: "ACCENT_COLOR", intent: ["palette"], dimensions: ["palette"], property: "color" },
  { type: "BUTTON_BACKGROUND", intent: ["button", "palette"], dimensions: ["button", "palette"], property: "background-color" },
  { type: "BUTTON_FOREGROUND", intent: ["button", "palette"], dimensions: ["button", "palette"], property: "color" },
  { type: "BUTTON_RADIUS", intent: ["button", "radius"], dimensions: ["button", "radius"], property: "border-radius" },
  { type: "BUTTON_SHADOW", intent: ["button", "shadow", "border", "palette"], dimensions: ["button", "shadow", "border", "palette"], property: "box-shadow" },
  { type: "BUTTON_BORDER", intent: ["button", "border"], dimensions: ["button", "border"], property: "border" },
  { type: "CARD_BACKGROUND", intent: ["card", "palette"], dimensions: ["card", "palette"], property: "background-color" },
  { type: "CARD_RADIUS", intent: ["card", "radius"], dimensions: ["card", "radius"], property: "border-radius" },
  { type: "CARD_SHADOW", intent: ["card", "shadow"], dimensions: ["card", "shadow"], property: "box-shadow" },
  { type: "CARD_BORDER", intent: ["card", "border"], dimensions: ["card", "border"], property: "border" },
  { type: "SECTION_SPACING", intent: ["section-spacing"], dimensions: ["section-spacing"], property: "padding-block" },
  { type: "COMPONENT_PADDING", intent: ["component-padding"], dimensions: ["component-padding"], property: "padding" },
  { type: "CTA_BACKGROUND", intent: ["card", "palette"], dimensions: ["card", "palette"], property: "background-color" },
]);
