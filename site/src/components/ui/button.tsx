import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Two small maps instead of class-variance-authority: three variants, two sizes.
 * cva earns its place when a component has axes that multiply, or defaults that
 * have to be merged per-axis; here the matrix is 3×2, one entry (`sm`) had no
 * callers, and every call site passes both axes literally. A plain lookup keeps
 * the same API with one less dependency and nothing to learn.
 */
const BASE =
  "inline-flex items-center justify-center gap-2 font-medium transition-[opacity,transform,background-color,color,box-shadow] duration-150 ease-out active:not-disabled:scale-[0.96] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70";

const VARIANT = {
  primary: "bg-accent text-accent-fg hover:opacity-90",
  ghost: "bg-transparent text-fg shadow-[0_0_0_1px_rgba(236,236,232,0.12)] hover:bg-bg-subtle",
  paper: "bg-paper text-paper-ink hover:opacity-95",
};

const SIZE = {
  md: "h-11 px-4 text-sm rounded-md",
  lg: "h-12 px-5 text-base rounded-lg",
};

type ButtonVariant = keyof typeof VARIANT;
type ButtonSize = keyof typeof SIZE;

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }
>(function Button({ className, variant = "primary", size = "md", ...props }, ref) {
  return (
    <button ref={ref} className={cn(BASE, VARIANT[variant], SIZE[size], className)} {...props} />
  );
});
