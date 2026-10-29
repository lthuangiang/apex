/** Dùng ở nhánh `default` để `switch` trên union luôn exhaustive (CODING_STANDARDS C2). */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
