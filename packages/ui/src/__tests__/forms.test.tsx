import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Button } from "../components/button";
import { Field, inputClassName } from "../components/field";
import { SegmentedControl } from "../components/segmented-control";
import { Switch } from "../components/switch";
import { expectNoAxeViolations } from "../test/axe";

describe("Field", () => {
  it("links label, hint and error to the input", async () => {
    render(
      <Field
        label="Grid count"
        source={{ tone: "ai", label: "AI" }}
        unit="levels"
        hint="Between 2 and 100"
        error="Too many levels"
      >
        {(props) => <input {...props} className={inputClassName} defaultValue="120" />}
      </Field>,
    );
    const input = screen.getByLabelText("Grid count");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("levels Between 2 and 100 Too many levels");
    expect(screen.getByText("AI")).toHaveAttribute("data-source", "ai");
    await expectNoAxeViolations();
  });

  it("shows why a field is locked", async () => {
    render(
      <Field label="Market" lockedReason="Market can't change on a running bot">
        {(props) => <input {...props} className={inputClassName} disabled defaultValue="BTC" />}
      </Field>,
    );
    expect(screen.getByLabelText("Market")).toHaveAccessibleDescription(
      "Market can't change on a running bot",
    );
    await expectNoAxeViolations();
  });
});

describe("Button", () => {
  it("blocks double submit while pending", async () => {
    const onClick = vi.fn();
    render(
      <Button pending onClick={onClick}>
        Starting…
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Starting…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("SegmentedControl", () => {
  function Harness() {
    const [value, setValue] = useState<"long" | "short" | "neutral">("long");
    return (
      <SegmentedControl
        label="Direction"
        value={value}
        onValueChange={setValue}
        options={[
          { value: "long", label: "Long" },
          { value: "short", label: "Short" },
          { value: "neutral", label: "Neutral", disabled: true },
        ]}
      />
    );
  }

  it("is a radiogroup that changes by click and keyboard", async () => {
    render(<Harness />);
    expect(screen.getByRole("radiogroup", { name: "Direction" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Short" }));
    expect(screen.getByRole("radio", { name: "Short" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Neutral" })).toBeDisabled();
    await expectNoAxeViolations();
  });
});

describe("Switch", () => {
  it("toggles with role switch", async () => {
    const onChange = vi.fn();
    render(<Switch label="Bot errors" checked={false} onCheckedChange={onChange} />);
    await userEvent.click(screen.getByRole("switch", { name: "Bot errors" }));
    expect(onChange).toHaveBeenCalledWith(true);
    await expectNoAxeViolations();
  });

  it("shows the disabled reason", async () => {
    render(
      <Switch
        label="Bot errors"
        checked
        onCheckedChange={() => undefined}
        disabled
        disabledReason="Always on"
      />,
    );
    const toggle = screen.getByRole("switch", { name: "Bot errors" });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAccessibleDescription("Always on");
    await expectNoAxeViolations();
  });
});
