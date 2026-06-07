"use client";

import React, { useState } from "react";
import type { Section, Collection, FormField } from "../../libs/types";
import { useFormEngineStore } from "../../store/form-engine-store";
import { cn } from "../../libs/utils";
import {
  TextFieldRenderer, MultilineFieldRenderer, BooleanFieldRenderer,
  NumberFieldRenderer, SelectFieldRenderer, MultiselectFieldRenderer,
  DateFieldRenderer, RatingFieldRenderer, FileFieldRenderer,
  ColorFieldRenderer, FieldWrapper,
} from "./fields/FieldRenderers";
import { evaluateCondition } from "../../libs/condition-evaluator";

// ─── Props ────────────────────────────────────────────────────────────────────
interface CollectionRendererProps {
  section: Section;
  collection: Collection;
  bindPrefix?: string;
}

type ItemAnswers = Record<string, unknown>;

// ─── Main component ───────────────────────────────────────────────────────────
export function CollectionRenderer({ section, collection, bindPrefix }: CollectionRendererProps) {
  const { answers, setAnswer, manifest } = useFormEngineStore();
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set([0]));

  const storageKey = bindPrefix || section.id || "collection";
  const items: ItemAnswers[] = (answers[storageKey] as ItemAnswers[]) ?? [];

  const setItems = (next: ItemAnswers[]) => setAnswer(storageKey, next);

  const addItem = () => {
    const next = [...items, {}];
    setItems(next);
    setExpandedItems(prev => new Set([...prev, next.length - 1]));
  };

  const removeItem = (idx: number) => {
    setItems(items.filter((_, i) => i !== idx));
    setExpandedItems(prev => {
      const next = new Set<number>();
      prev.forEach(i => { if (i < idx) next.add(i); else if (i > idx) next.add(i - 1); });
      return next;
    });
    if (expandedItems.has(idx)) {
      setExpandedItems(prev => { const n = new Set(prev); n.delete(idx); return n; });
    }
  };

  const moveItem = (idx: number, dir: "up" | "down") => {
    const next = [...items];
    const to = dir === "up" ? idx - 1 : idx + 1;
    if (to < 0 || to >= next.length) return;
    [next[idx], next[to]] = [next[to], next[idx]];
    setItems(next);
  };

  const updateItemField = (idx: number, fieldId: string, value: unknown) => {
    const next = items.map((item, i) => i === idx ? { ...item, [fieldId]: value } : item);
    setItems(next);
  };

  const getTitle = (item: ItemAnswers, idx: number) => {
    const tpl = collection.item_title_template;
    if (!tpl) return `${section.title ?? "Item"} ${idx + 1}`;
    return tpl
      .replace(/\{\{index\}\}/g, String(idx + 1))
      .replace(/\{\{fields\.([^}]+)\}\}/g, (_, k) => String(item[k] ?? ""));
  };

  const canAdd    = collection.max_items == null || items.length < collection.max_items;
  const canRemove = items.length > (collection.min_items ?? 0);
  const namedConds = manifest?.conditions ?? {};

  return (
    <div className="space-y-3">
      {items.length === 0 && (
        <div className="rounded-xl border-2 border-dashed border-gray-200 dark:border-gray-700 p-8 text-center text-sm text-gray-400">
          No items yet. Click "{collection.add_label ?? "Add Item"}" below to start.
        </div>
      )}

      {items.map((item, idx) => {
        const isExpanded = collection.default_expanded !== false
          ? expandedItems.has(idx)
          : expandedItems.has(idx);

        // Visible fields for this item (evaluate conditions against item answers)
        const allFields = section.fields ?? [];
        const visibleFields = allFields.filter(f =>
          !f.condition || evaluateCondition(f.condition, item, namedConds)
        );
        const basicFields = visibleFields.filter(f => !f.advanced);
        const proFields   = visibleFields.filter(f => !!f.advanced);

        return (
          <div key={idx} className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            {/* Card header */}
            <div
              className="flex items-center gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-800/60 cursor-pointer select-none"
              onClick={() => setExpandedItems(prev => {
                const n = new Set(prev);
                n.has(idx) ? n.delete(idx) : n.add(idx);
                return n;
              })}
            >
              {collection.sortable && (
                <div className="flex flex-col gap-0.5" onClick={e => e.stopPropagation()}>
                  <button type="button" onClick={() => moveItem(idx, "up")} disabled={idx === 0}
                    className="text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs leading-none">▲</button>
                  <button type="button" onClick={() => moveItem(idx, "down")} disabled={idx === items.length - 1}
                    className="text-gray-400 hover:text-gray-600 disabled:opacity-20 text-xs leading-none">▼</button>
                </div>
              )}
              <span className={cn("text-gray-400 text-xs transition-transform", isExpanded && "rotate-90")}>▶</span>
              <span className="flex-1 text-sm font-medium text-gray-700 dark:text-gray-200">
                {getTitle(item, idx)}
              </span>
              {canRemove && (
                <button type="button" onClick={e => { e.stopPropagation(); removeItem(idx); }}
                  className="text-xs text-red-500 hover:text-red-700 px-2 py-0.5 rounded hover:bg-red-50 transition-colors">
                  {collection.remove_label ?? "Remove"}
                </button>
              )}
            </div>

            {isExpanded && (
              <div className="p-4 space-y-4">
                {/* Basic fields */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-4">
                  {basicFields.map(field => (
                    <div key={field.id} className={cn(
                      field.width === "half" ? "col-span-1" :
                      field.width === "third" ? "col-span-1" : "col-span-2"
                    )}>
                      <ScopedField
                        field={field}
                        value={item[field.id]}
                        allValues={item}
                        onChange={v => updateItemField(idx, field.id, v)}
                      />
                    </div>
                  ))}
                </div>

                {/* Pro fields */}
                {proFields.length > 0 && (
                  <ProFieldsSection fields={proFields} itemValues={item}
                    onFieldChange={(fid, v) => updateItemField(idx, fid, v)} />
                )}
              </div>
            )}
          </div>
        );
      })}

      {canAdd && (
        <button type="button" onClick={addItem}
          className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-600 px-4 py-3 text-sm font-medium text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors">
          <span className="text-lg leading-none">+</span>
          {collection.add_label ?? "Add Item"}
        </button>
      )}
    </div>
  );
}

// ─── Pro fields collapsible panel ─────────────────────────────────────────────
export function ProFieldsSection({ fields, itemValues, onFieldChange, globalAnswers }: {
  fields: FormField[];
  itemValues?: Record<string, unknown>;
  onFieldChange?: (fieldId: string, value: unknown) => void;
  globalAnswers?: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  const store = useFormEngineStore();

  return (
    <div className="border-t border-gray-100 dark:border-gray-700 pt-3">
      <button type="button" onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-blue-600 transition-colors group">
        <span className={cn("transition-transform text-xs", open && "rotate-90")}>▶</span>
        <span className="font-medium group-hover:underline">
          {open ? "Hide advanced options" : `More options (${fields.length})`}
        </span>
      </button>

      {open && (
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-4">
          {fields.map(field => (
            <div key={field.id} className={cn(
              field.width === "half" ? "col-span-1" :
              field.width === "third" ? "col-span-1" : "col-span-2"
            )}>
              {onFieldChange && itemValues !== undefined ? (
                <ScopedField
                  field={field}
                  value={itemValues[field.id]}
                  allValues={itemValues}
                  onChange={v => onFieldChange(field.id, v)}
                />
              ) : (
                // fall back to store-connected rendering
                <ScopedField
                  field={field}
                  value={store.answers[field.id]}
                  allValues={store.answers}
                  onChange={v => store.setAnswer(field.id, v)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Scoped field renderer (value + onChange passed directly, no store) ───────
function ScopedField({ field, value, allValues, onChange }: {
  field: FormField;
  value: unknown;
  allValues: Record<string, unknown>;
  onChange: (v: unknown) => void;
}) {
  const [touched, setTouched] = useState(false);
  const errors: string[] = [];  // validation skipped inside collections for simplicity

  const handleBlur = () => setTouched(true);
  const props = { field, value, onChange, onBlur: handleBlur, errors };
  const type = (field as unknown as Record<string, unknown>).type as string;

  switch (type) {
    case "text":        return <TextFieldRenderer       {...props} field={field as any} />;
    case "multiline":   return <MultilineFieldRenderer  {...props} field={field as any} />;
    case "boolean":     return <BooleanFieldRenderer    {...props} field={field as any} />;
    case "number":      return <NumberFieldRenderer     {...props} field={field as any} />;
    case "select":      return <SelectFieldRenderer     {...props} field={field as any} />;
    case "multiselect": return <MultiselectFieldRenderer {...props} field={field as any} />;
    case "date":        return <DateFieldRenderer       {...props} field={field as any} />;
    case "rating":      return <RatingFieldRenderer     {...props} field={field as any} />;
    case "file":        return <FileFieldRenderer       {...props} field={field as any} />;
    case "color":       return <ColorFieldRenderer      {...props} field={field as any} />;
    case "time":
      return (
        <FieldWrapper label={field.label} required={field.required} hint={field.hint} width={field.width}>
          <input type="time" value={String(value ?? "")} onChange={e => onChange(e.target.value || null)} onBlur={handleBlur}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
        </FieldWrapper>
      );
    case "richtext": return <MultilineFieldRenderer {...props} field={{ ...field, type: "multiline" } as any} />;
    case "json":
      return (
        <FieldWrapper label={field.label} required={field.required} hint={field.hint} width={field.width}>
          <JsonInlineEditor value={value} onChange={onChange} />
        </FieldWrapper>
      );
    default:
      return (
        <FieldWrapper label={field.label} width={field.width}>
          <div className="text-xs text-gray-400 italic">Unsupported: {type}</div>
        </FieldWrapper>
      );
  }
}


// ─── JsonInlineEditor (used inside collections) ───────────────────────────────
// Simplified: array → add/remove rows; object → key-value; else → textarea
function JsonInlineEditor({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const isArray  = Array.isArray(value);
  const isObject = !isArray && value !== null && typeof value === "object";

  if (isArray) {
    const items = value as unknown[];
    return (
      <div className="space-y-1.5">
        {items.map((item, idx) => (
          <div key={idx} className="flex gap-1.5 items-center">
            <span className="text-xs text-gray-400 w-5 text-right">{idx + 1}.</span>
            <input value={String(item ?? "")} onChange={e => onChange(items.map((it,i) => i===idx ? e.target.value : it))}
              className="flex-1 rounded-md border border-gray-200 px-2 py-1 text-xs bg-white focus:border-blue-400 focus:outline-none" />
            <button type="button" onClick={() => onChange(items.filter((_,i) => i!==idx))}
              className="text-gray-300 hover:text-red-500 text-xs px-1">✕</button>
          </div>
        ))}
        <button type="button" onClick={() => onChange([...items, ""])}
          className="text-xs text-blue-600 hover:underline">+ Add item</button>
      </div>
    );
  }

  if (isObject) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    return (
      <div className="space-y-1.5">
        {keys.map(k => (
          <div key={k} className="flex gap-1.5 items-center">
            <span className="text-xs font-mono text-gray-500 w-24 truncate">{k}</span>
            <input value={String(obj[k] ?? "")} onChange={e => onChange({ ...obj, [k]: e.target.value })}
              className="flex-1 rounded-md border border-gray-200 px-2 py-1 text-xs bg-white focus:border-blue-400 focus:outline-none" />
            <button type="button" onClick={() => { const n={...obj}; delete n[k]; onChange(n); }}
              className="text-gray-300 hover:text-red-500 text-xs px-1">✕</button>
          </div>
        ))}
        <button type="button" onClick={() => onChange({ ...obj, [`key_${keys.length+1}`]: "" })}
          className="text-xs text-blue-600 hover:underline">+ Add field</button>
      </div>
    );
  }

  return (
    <textarea value={typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2)}
      onChange={e => { try { onChange(JSON.parse(e.target.value)); } catch { onChange(e.target.value); } }}
      rows={4}
      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs font-mono focus:border-blue-500 focus:outline-none" />
  );
}
