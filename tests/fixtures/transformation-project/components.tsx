import { cva } from "class-variance-authority";
const styles = cva("rounded-full px-6 py-3 shadow-lg", { variants: { variant: { default: "bg-primary text-primary-foreground", secondary: "bg-card text-foreground" } }, defaultVariants: { variant: "default" } });
export function Button({ variant, ...props }) { return <button data-slot="button" className={styles({ variant })} {...props} />; }
export function Card({ className, ...props }) { return <div data-slot="card" className={"rounded-lg bg-card border p-7 shadow-xl " + (className ?? "")} {...props} />; }
