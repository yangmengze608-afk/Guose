import type { ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

export const buttonVariants = cva(
  "inline-flex min-h-11 items-center justify-center rounded-full px-6 py-3 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  { variants: { variant: {
    default: "bg-primary text-primary-foreground shadow-lg shadow-indigo-200 hover:bg-indigo-800",
    secondary: "border border-border bg-card text-foreground hover:bg-secondary",
  } }, defaultVariants: { variant: "default" } }
);
type Props = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;
export function Button({ className, variant, type = "button", ...props }: Props) {
  return <button data-slot="button" type={type} className={cn(buttonVariants({ variant }), className)} {...props} />;
}
