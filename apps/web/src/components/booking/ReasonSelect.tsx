import { DEPARTMENT_LABELS, DEPARTMENTS } from '@carbooking/core';
import { Select } from '../ui/form';
import type { VisitReason } from '@/lib/types';

/** Reasons for visit, grouped by department. */
export function ReasonSelect({ reasons, value, onChange, id, invalid }: { reasons: VisitReason[]; value: string; onChange: (id: string) => void; id?: string; invalid?: boolean }) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid || undefined}>
      <option value="">Reason for the visit…</option>
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
  );
}
