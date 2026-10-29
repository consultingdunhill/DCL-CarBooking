import { DEPARTMENT_LABELS, DEPARTMENTS } from "@carbooking/core";
import { Check, ChevronDown, ClipboardList } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { VisitReason } from "@/lib/types";
import { Badge } from "../ui/badge";
import { Label } from "../ui/form";
import { cn } from "@/lib/utils";

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
  const listId = `${selectId}-options`;
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedReason = reasons.find((reason) => reason.id === value);
  const groupedReasons = DEPARTMENTS.map((department) => ({
    department,
    reasons: reasons.filter((reason) => reason.department === department),
  })).filter((group) => group.reasons.length > 0);
  const flatReasons = groupedReasons.flatMap((group) => group.reasons);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, flatReasons.findIndex((reason) => reason.id === value)));

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const choose = (reason: VisitReason) => {
    onChange(reason.id);
    setActiveIndex(flatReasons.findIndex((item) => item.id === reason.id));
    setOpen(false);
  };

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={selectId}>Visit reason</Label>
      <div ref={rootRef} className="relative">
        <button
          id={selectId}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-haspopup="listbox"
          aria-activedescendant={open && flatReasons[activeIndex] ? `${listId}-${flatReasons[activeIndex]!.id}` : undefined}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          onClick={() => {
            setActiveIndex(Math.max(0, flatReasons.findIndex((reason) => reason.id === value)));
            setOpen((isOpen) => !isOpen);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!open) {
                const selectedIndex = flatReasons.findIndex((reason) => reason.id === value);
                setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
                setOpen(true);
              } else {
                setActiveIndex((index) =>
                  event.key === "ArrowDown"
                    ? Math.min(flatReasons.length - 1, index + 1)
                    : Math.max(0, index - 1),
                );
              }
            } else if (event.key === "Enter" || event.key === " ") {
              if (open && flatReasons[activeIndex]) {
                event.preventDefault();
                choose(flatReasons[activeIndex]!);
              } else if (!open) {
                event.preventDefault();
                setOpen(true);
              }
            } else if (event.key === "Escape") {
              setOpen(false);
            }
          }}
          className={cn(
            "flex h-12 w-full items-center gap-3 rounded-xl border border-border bg-surface-2 px-3 text-left text-sm text-fg transition-colors",
            "hover:bg-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20",
            invalid && "border-danger",
          )}
        >
          <ClipboardList className="size-4 shrink-0 text-muted-fg" />
          <span className={cn("min-w-0 flex-1 truncate", !selectedReason && "text-muted-fg")}>
            {selectedReason?.label ?? "Choose a reason for this visit…"}
          </span>
          <ChevronDown className={cn("size-4 shrink-0 text-muted-fg transition-transform", open && "rotate-180")} />
        </button>
        {open && (
          <div
            id={listId}
            role="listbox"
            aria-labelledby={selectId}
            className="absolute inset-x-0 top-full z-40 mt-1 max-h-64 overflow-y-auto rounded-xl border border-border bg-surface py-1 shadow-float"
          >
            {groupedReasons.map(({ department, reasons: departmentReasons }) => (
              <div key={department}>
                <p className="px-3 pb-1 pt-2 text-xs font-semibold text-muted-fg">
                  {DEPARTMENT_LABELS[department]}
                </p>
                {departmentReasons.map((reason) => {
                  const index = flatReasons.findIndex((item) => item.id === reason.id);
                  const selected = reason.id === value;
                  return (
                    <div
                      key={reason.id}
                      id={`${listId}-${reason.id}`}
                      role="option"
                      aria-selected={selected}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => choose(reason)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors",
                        index === activeIndex ? "bg-muted" : "hover:bg-muted",
                      )}
                    >
                      <span className="min-w-0 flex-1">{reason.label}</span>
                      {reason.needsProperty && (
                        <span className="shrink-0 text-xs text-muted-fg">Property required</span>
                      )}
                      {selected && <Check className="size-4 shrink-0 text-primary" />}
                    </div>
                  );
                })}
              </div>
            ))}
            {flatReasons.length === 0 && (
              <p className="px-3 py-2 text-sm text-muted-fg">No visit reasons are available.</p>
            )}
          </div>
        )}
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
