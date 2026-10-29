import { DEPARTMENT_LABELS, DEPARTMENTS } from "@carbooking/core";
import { ClipboardList } from "lucide-react";
import { useId } from "react";
import type { VisitReason } from "@/lib/types";
import { Badge } from "../ui/badge";
import { Label, Select } from "../ui/form";

/** Reasons for visit, grouped by department. */
export function ReasonSelect({
  reasons,
  value,
  onChange,
  id,
  invalid,
}: {
  reasons: VisitReason[];
  value: string;
  onChange: (id: string) => void;
  id?: string;
  invalid?: boolean;
}) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const errorId = `${selectId}-error`;
  const selectedReason = reasons.find((reason) => reason.id === value);

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={selectId}>Visit reason</Label>
      <div className="relative">
        <ClipboardList className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-fg" />
        <Select
          id={selectId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          className="h-12 rounded-xl bg-surface-2 pl-10"
        >
          <option value="">Choose a reason for this visit…</option>
          {DEPARTMENTS.map((d) => {
            const items = reasons.filter((r) => r.department === d);
            if (!items.length) return null;
            return (
              <optgroup key={d} label={DEPARTMENT_LABELS[d]}>
                {items.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </Select>
      </div>
      {invalid && (
        <p id={errorId} className="text-xs text-danger">
          Choose a reason for this stop.
        </p>
      )}
      {selectedReason ? (
        <div className="flex flex-wrap gap-1.5" aria-live="polite">
          <Badge>{DEPARTMENT_LABELS[selectedReason.department]}</Badge>
          {selectedReason.countsAsViewing && <Badge tone="primary">Counts as a viewing</Badge>}
          {selectedReason.needsProperty && <Badge tone="info">Property required</Badge>}
        </div>
      ) : (
        !invalid && <p className="text-xs text-muted-fg">Pick the reason that best describes this stop.</p>
      )}
    </div>
  );
}
