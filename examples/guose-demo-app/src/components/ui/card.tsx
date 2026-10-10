import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="card" className={cn("rounded-lg border border-border bg-card p-7 text-card-foreground shadow-xl shadow-indigo-100/70", className)} {...props} />;
}
