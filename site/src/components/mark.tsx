import { cn } from "@/lib/utils";

export function DuckMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7", className)} aria-hidden="true" fill="none">
      <circle cx="13" cy="12" r="6.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M19.2 12.2h5.2l-5.2 3.4v-3.4z" fill="currentColor" />
      <path
        d="M8 18.5c1.6 4.2 5 6.6 10.4 6.6 4.2 0 6.8-1.6 8.2-3.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="11.6" cy="11.2" r="1.1" fill="currentColor" />
    </svg>
  );
}
