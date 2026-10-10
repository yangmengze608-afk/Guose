import { cva } from "class-variance-authority";

export const buttonStyles = cva("rounded-md px-4 py-2", {
  variants: {
    intent: {
      primary: "bg-primary text-primary-foreground",
      destructive: "bg-destructive text-destructive-foreground",
    },
  },
});

// Variant definitions are static evidence, not proof of the rendered selection.
export function Button({ intent }: { intent: "primary" | "destructive" }) {
  return <button className={buttonStyles({ intent })}>Static fixture</button>;
}

export function DynamicBadge({ tone }: { tone: string }) {
  return <span className={`bg-${tone}`}>Unknown dynamic class</span>;
}
