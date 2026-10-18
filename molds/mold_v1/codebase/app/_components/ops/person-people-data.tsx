"use client";

/**
 * A person's department(s) and attributes in the Control Panel's person drawer (the People tab), in the deployment
 * profile's words (agent/lib/people-catalogue.ts, profiles `people`). The workspace's owner and admins set them; anyone
 * else reads the departments, and their own attributes. Nothing renders when the profile declares neither, so the
 * default drawer is what it was. The server holds every rule again (POST /api/ops/roster, agent/lib/people-data.ts).
 */
import { useEffect, useState } from "react";
import { PEOPLE, departmentLabel, type AttributeValue, type PersonAttributes } from "@/agent/lib/people-catalogue";
import type { PersonAttributeSpec } from "@/lib/deployment-profile.generated";

const upperFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const field =
  "w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

export interface PeopleDataPatch {
  departments?: string[];
  attributes?: Record<string, AttributeValue | null>;
}

export function PersonPeopleData({
  departments,
  attributes,
  canEdit,
  saving,
  onSave,
  Field,
}: {
  readonly departments: string[] | undefined;
  /** undefined: this reader may not read them (only the person and the workspace's owner and admins do). */
  readonly attributes: PersonAttributes | undefined;
  readonly canEdit: boolean;
  readonly saving: boolean;
  readonly onSave: (patch: PeopleDataPatch) => void;
  readonly Field: (p: { label: string; children: React.ReactNode }) => React.ReactNode;
}) {
  const word = PEOPLE.department;
  const held = departments ?? [];
  return (
    <>
      {PEOPLE.hasDepartments && (
        <Field label={upperFirst(PEOPLE.multipleDepartments ? word.plural : word.singular)}>
          {canEdit ? (
            PEOPLE.multipleDepartments ? (
              <div className="flex flex-col gap-1">
                {PEOPLE.departments.map((d) => (
                  <label key={d.key} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      disabled={saving}
                      checked={held.includes(d.key)}
                      onChange={(e) => onSave({ departments: e.target.checked ? [...held, d.key] : held.filter((k) => k !== d.key) })}
                    />
                    {d.label}
                  </label>
                ))}
              </div>
            ) : (
              <select
                aria-label={upperFirst(word.singular)}
                value={held[0] ?? ""}
                disabled={saving}
                onChange={(e) => onSave({ departments: e.target.value ? [e.target.value] : [] })}
                className={field}
              >
                <option value="">None</option>
                {PEOPLE.departments.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            )
          ) : held.length ? (
            held.map(departmentLabel).join(", ")
          ) : (
            "—"
          )}
        </Field>
      )}
      {PEOPLE.hasAttributes && attributes !== undefined &&
        PEOPLE.attributes.map((spec) => (
          <Field key={spec.key} label={spec.label}>
            {canEdit ? (
              <AttributeEditor spec={spec} value={attributes[spec.key]} saving={saving} onSave={(v) => onSave({ attributes: { [spec.key]: v } })} />
            ) : (
              attributeText(spec, attributes[spec.key])
            )}
            {spec.help ? <div className="mt-1 text-2xs text-muted-foreground">{spec.help}</div> : null}
          </Field>
        ))}
    </>
  );
}

/** An attribute's value as a person reads it: option labels, Yes / No, the text. */
function attributeText(spec: PersonAttributeSpec, v: AttributeValue | undefined): string {
  if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) return "—";
  const label = (x: string) => spec.options?.find((o) => o.value === x)?.label ?? x;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return Array.isArray(v) ? v.map(label).join(", ") : spec.type === "choice" ? label(v) : v;
}

function AttributeEditor({
  spec,
  value,
  saving,
  onSave,
}: {
  readonly spec: PersonAttributeSpec;
  readonly value: AttributeValue | undefined;
  readonly saving: boolean;
  readonly onSave: (v: AttributeValue | null) => void;
}) {
  const [draft, setDraft] = useState(typeof value === "string" ? value : "");
  useEffect(() => setDraft(typeof value === "string" ? value : ""), [value]);
  switch (spec.type) {
    case "boolean":
      return (
        <select aria-label={spec.label} value={value === true ? "yes" : value === false ? "no" : ""} disabled={saving} onChange={(e) => onSave(e.target.value === "" ? null : e.target.value === "yes")} className={field}>
          <option value="">—</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      );
    case "choice":
      return (
        <select aria-label={spec.label} value={typeof value === "string" ? value : ""} disabled={saving} onChange={(e) => onSave(e.target.value || null)} className={field}>
          <option value="">—</option>
          {(spec.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "multi_choice": {
      const held = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-col gap-1">
          {(spec.options ?? []).map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={saving}
                checked={held.includes(o.value)}
                onChange={(e) => onSave(e.target.checked ? [...held, o.value] : held.filter((x) => x !== o.value))}
              />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    case "text":
      return (
        <input
          aria-label={spec.label}
          value={draft}
          disabled={saving}
          maxLength={500}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft !== (typeof value === "string" ? value : "") && onSave(draft.trim() || null)}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className={field}
        />
      );
  }
}
