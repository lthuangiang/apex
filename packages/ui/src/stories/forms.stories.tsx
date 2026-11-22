import type { Meta, StoryObj } from "@storybook/react-vite";
import { useId, useState } from "react";

import { Button } from "../components/button";
import { Field, inputClassName } from "../components/field";
import { SegmentedControl } from "../components/segmented-control";
import { Select } from "../components/select";
import { Switch } from "../components/switch";

const meta: Meta = {
  title: "Form/Controls",
  decorators: [
    (Story) => (
      <div className="flex max-w-md flex-col gap-6">
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj;

/** Mặc định, nguồn AI, đã sửa, lỗi và bị khoá. */
export const Fields: Story = {
  render: () => (
    <>
      <Field label="Investment" unit="USDC" hint="Available 1,200 USDC">
        {(props) => <input {...props} className={inputClassName} defaultValue="500" />}
      </Field>
      <Field label="Grid count" source={{ tone: "ai", label: "AI" }}>
        {(props) => <input {...props} className={inputClassName} defaultValue="24" />}
      </Field>
      <Field label="Lower price" source={{ tone: "edited", label: "Edited" }} unit="USDC">
        {(props) => <input {...props} className={inputClassName} defaultValue="61200" />}
      </Field>
      <Field label="Upper price" unit="USDC" error="Upper price must be above lower price">
        {(props) => <input {...props} className={inputClassName} defaultValue="60000" />}
      </Field>
      <Field label="Market" lockedReason="Market can't change on a running bot">
        {(props) => (
          <input {...props} className={inputClassName} defaultValue="BTC-PERP" disabled />
        )}
      </Field>
    </>
  ),
};

export const Buttons: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Button>Start on mainnet</Button>
      <Button variant="secondary">Cancel</Button>
      <Button variant="tonal">✦ AI parameters</Button>
      <Button variant="danger">Stop…</Button>
      <Button pending>Starting…</Button>
      <Button disabled>Disabled</Button>
    </div>
  ),
};

function SegmentedDemo({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState<"long" | "short" | "neutral">("long");
  return (
    <SegmentedControl
      label="Direction"
      value={value}
      onValueChange={setValue}
      disabled={disabled}
      options={[
        { value: "long", label: "Long" },
        { value: "short", label: "Short" },
        { value: "neutral", label: "Neutral" },
      ]}
    />
  );
}

export const Segmented: Story = {
  render: () => (
    <>
      <SegmentedDemo />
      <SegmentedDemo disabled />
    </>
  ),
};

function ModeDemo({ start }: { start: "paper" | "mainnet" }) {
  const [value, setValue] = useState(start);
  return (
    <SegmentedControl
      label="Bots"
      value={value}
      onValueChange={setValue}
      options={[
        { value: "paper", label: "Paper", tone: "warn" },
        { value: "mainnet", label: "Mainnet", tone: "pos" },
      ]}
    />
  );
}

/** #454: tab Paper / Mainnet của Signal Research; chỉ lựa chọn đang chọn mang màu chế độ. */
export const SegmentedTone: Story = {
  render: () => (
    <>
      <ModeDemo start="paper" />
      <ModeDemo start="mainnet" />
    </>
  ),
};

function SelectDemo({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState("v3");
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-extrabold text-ink">
        Version
      </label>
      <Select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          setValue(e.target.value);
        }}
        className="w-full md:w-auto md:min-w-[190px]"
      >
        <optgroup label="Team versions">
          <option value="v3">Baseline (v3)</option>
          <option value="v4">v4 · Strict subject</option>
        </optgroup>
        <optgroup label="My versions">
          <option value="v5">v5 · Majors only</option>
        </optgroup>
      </Select>
    </div>
  );
}

/** #457: ô chọn Bot / Version của Signal Research, giống nhau trên Safari / Firefox / Chrome. */
export const SelectBox: Story = {
  render: () => (
    <>
      <SelectDemo />
      <SelectDemo disabled />
    </>
  ),
};

function SwitchDemo() {
  const [on, setOn] = useState(true);
  return (
    <Switch
      label="Order fills"
      description="Notify when an order fills"
      checked={on}
      onCheckedChange={setOn}
    />
  );
}

export const Switches: Story = {
  render: () => (
    <>
      <SwitchDemo />
      <Switch
        label="Bot errors"
        checked
        onCheckedChange={() => undefined}
        disabled
        disabledReason="Always on"
      />
    </>
  ),
};
