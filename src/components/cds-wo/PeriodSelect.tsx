"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";

type Props = {
  value: string;
  options: { value: string; label: string }[];
  id?: string;
  className?: string;
  /** Current query string without the period (e.g. "q=ryder&status=accepted"). */
  keep?: string;
};

/** Dashboard period select: changing it reloads the page with ?period=..., keeping other filters. */
export function PeriodSelect({ value, options, id, className, keep = "" }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  return (
    <select
      id={id}
      className={className}
      value={value}
      disabled={pending}
      aria-label="Dashboard period"
      onChange={(e) => {
        const next = new URLSearchParams(keep);
        if (e.target.value === "month") next.delete("period");
        else next.set("period", e.target.value);
        const qs = next.toString();
        startTransition(() => router.push(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false }));
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
