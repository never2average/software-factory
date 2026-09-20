"use client";

/**
 * The deployment profile's OWN fields (`domains.<area>.custom_fields`) on the two record areas' forms: one
 * control per field type, used by the "New …" form and by the detail card (todos-panel.tsx). What a value may be
 * is decided by agent/lib/custom-fields.ts — the same validator the API runs — so a person reads the same
 * sentence here, before the request, that the API would have answered with.
 */
import { useId } from "react";
import { cn } from "@/lib/utils";
import { inputTypeOf, validateCustom } from "@/agent/lib/custom-fields";
import type { CustomFieldSpec, DomainArea } from "@/lib/deployment-profile.generated";
import { OpsInput, OpsSelect, OpsTextarea } from "./primitives";
import { SPACE, TYPE } from "./tokens";

/** The sentence for one field's typed value, or null when it is fine. "" is "not filled in". */
export function customFieldError(area: DomainArea, field: CustomFieldSpec, typed: string, mode: "create" | "update"): string | null {
  const result = validateCustom(area, { [field.key]: typed }, { mode, fields: [field] });
  return result.ok ? null : result.errors[0];
}

/**
 * Label (with a required marker), the control for the field's type, its help, its error.
 * Controlled (`value` + `onChange`) on the create form; on the detail card pass `onCommit` and it saves on
 * blur / on pick, like the built-in fields next to it.
 */
export function CustomFieldControl({
  field,
  value,
  error,
  disabled,
  onChange,
  onCommit,
}: {
  readonly field: CustomFieldSpec;
  readonly value: string;
  readonly error?: string | null;
  readonly disabled?: boolean;
  readonly onChange?: (value: string) => void;
  readonly onCommit?: (value: string) => void;
}) {
  const id = useId();
  const described = [field.help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  const shared = {
    id,
    name: `custom.${field.key}`,
    disabled,
    required: field.required,
    "aria-required": field.required || undefined,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": described,
  };
  // Controlled while creating; on the card the stored value is the default and a blur commits, as its neighbours do.
  const bind = onChange ? { value } : { defaultValue: value };
  return (
    // The label names ONLY the field: help and error are tied in with aria-describedby, not read as part of the name.
    <div data-custom-field={field.key} className={cn("flex min-w-0 flex-col", SPACE.fieldGap, field.type === "long_text" ? "col-span-2" : null)}>
      <label htmlFor={id}>
        <span className={cn("font-medium text-muted-foreground", TYPE.meta)}>
          {field.label}
          {field.required ? <span aria-hidden="true" className="text-red-400"> *</span> : null}
        </span>
      </label>
      {field.type === "pick_list" ? (
        <OpsSelect
          key={onChange ? undefined : value}
          {...shared}
          {...bind}
          onChange={(e) => {
            onChange?.(e.target.value);
            if (e.target.value !== value) onCommit?.(e.target.value);
          }}
        >
          <option value="">{field.required ? "Choose…" : "—"}</option>
          {value && !(field.options ?? []).includes(value) ? <option value={value}>{value}</option> : null}
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </OpsSelect>
      ) : field.type === "long_text" ? (
        <OpsTextarea key={onChange ? undefined : value} {...shared} {...bind} rows={3} onChange={(e) => onChange?.(e.target.value)} onBlur={(e) => onCommit?.(e.target.value.trim())} />
      ) : (
        <OpsInput
          key={onChange ? undefined : value}
          {...shared}
          {...bind}
          type={inputTypeOf(field.type)}
          inputMode={field.type === "number" || field.type === "percent" ? "decimal" : undefined}
          step={field.type === "number" || field.type === "percent" ? "any" : undefined}
          min={field.type === "percent" ? 0 : undefined}
          max={field.type === "percent" ? 100 : undefined}
          placeholder={field.type === "link" ? "https://…" : field.type === "email" ? "name@company.com" : undefined}
          onChange={(e) => onChange?.(e.target.value)}
          onBlur={(e) => onCommit?.(e.target.value.trim())}
        />
      )}
      {field.help ? (
        <span id={`${id}-help`} className={cn("text-muted-foreground/60", TYPE.micro)}>
          {field.help}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-error`} role="alert" className={cn("text-red-400", TYPE.micro)}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
