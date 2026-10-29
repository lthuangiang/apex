import * as RadioGroup from "@radix-ui/react-radio-group";

import { cx } from "../lib/cx";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  /** Tên nhóm cho trình đọc màn hình. */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  disabled?: boolean;
  /** Rộng hết vùng chứa, các lựa chọn chia đều (form của artboard Create). */
  fullWidth?: boolean;
  className?: string;
}

/** Chọn một trong vài giá trị, dùng `radiogroup` (docs/DESIGN.md, Accessibility). */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onValueChange,
  disabled = false,
  fullWidth = false,
  className,
}: SegmentedControlProps<T>) {
  const handleChange = (next: string) => {
    const option = options.find((o) => o.value === next);
    if (option) onValueChange(option.value);
  };

  return (
    <RadioGroup.Root
      aria-label={label}
      value={value}
      onValueChange={handleChange}
      disabled={disabled}
      orientation="horizontal"
      className={cx(
        "flex-wrap gap-1 rounded-control bg-surface-2 p-1",
        fullWidth ? "flex w-full" : "inline-flex",
        className,
      )}
    >
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled === true}
          className={cx(
            "min-h-10 rounded-[10px] px-3 text-sm font-semibold text-ink-2 data-[state=checked]:bg-surface data-[state=checked]:text-ink data-[state=checked]:shadow-sm disabled:cursor-not-allowed disabled:opacity-60",
            fullWidth ? "flex-1 whitespace-nowrap" : undefined,
          )}
        >
          {option.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
