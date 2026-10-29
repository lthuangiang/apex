import * as RadixSwitch from "@radix-ui/react-switch";
import { useId } from "react";

import { cx } from "../lib/cx";

export interface SwitchProps {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Lý do bị disable; luôn hiển thị (mục 12, UI). */
  disabledReason?: string;
  className?: string;
}

export function Switch({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
  disabledReason,
  className,
}: SwitchProps) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const reasonId = `${id}-reason`;
  const describedBy = [
    description ? descriptionId : null,
    disabled && disabledReason ? reasonId : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cx("flex items-start justify-between gap-4", className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-semibold text-ink">
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="text-xs text-muted">
            {description}
          </p>
        ) : null}
        {disabled && disabledReason ? (
          <p id={reasonId} className="text-xs font-medium text-ink-2">
            {disabledReason}
          </p>
        ) : null}
      </div>
      <RadixSwitch.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        {...(describedBy ? { "aria-describedby": describedBy } : {})}
        className="relative inline-flex h-7 w-12 shrink-0 items-center rounded-full bg-border-input transition-colors data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-60 before:absolute before:-inset-2 before:content-['']"
      >
        <RadixSwitch.Thumb className="block size-5 translate-x-1 rounded-full bg-surface shadow transition-transform data-[state=checked]:translate-x-6" />
      </RadixSwitch.Root>
    </div>
  );
}
