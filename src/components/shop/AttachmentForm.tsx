"use client";

import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { prepareUpload, registerUpload, type UploadMeta } from "@/app/shop/actions";
import { ATTACHMENT_CATEGORY_LABEL } from "@/lib/format";
import { isNextControlError } from "@/lib/next-errors";
import { browserClient } from "./browserClient";
import type { Option } from "./types";

const MAX_BYTES = 25 * 1024 * 1024;

type Step = "waiting" | "uploading" | "saving" | "done" | "error";
type Progress = { name: string; step: Step; message?: string };

const STEP_LABEL: Record<Step, string> = {
  waiting: "Waiting",
  uploading: "Uploading...",
  saving: "Saving...",
  done: "Added",
  error: "Failed",
};

/** Client-side check only, for a quick answer. The server checks again before and after. */
function precheck(f: File): string | null {
  if (!(f.type.startsWith("image/") || f.type === "application/pdf")) return "only photos and PDF files can be added.";
  if (f.size > MAX_BYTES) return "larger than 25 MB.";
  return null;
}

type FieldValues = Record<string, string>;

/** What each field holds right now. Files are compared by name, size and date. */
function readFields(form: HTMLFormElement): FieldValues {
  const values: FieldValues = {};
  for (const el of Array.from(form.elements)) {
    if (el instanceof HTMLInputElement && el.type === "file") {
      values[el.id] = Array.from(el.files ?? [])
        .map((f) => `${f.name}:${f.size}:${f.lastModified}`)
        .join("|");
    } else if ((el instanceof HTMLInputElement || el instanceof HTMLSelectElement) && el.id) {
      values[el.id] = el.value;
    }
  }
  return values;
}

/**
 * Clears what was submitted. The fields are locked during the upload, so normally nothing
 * changed and the whole form resets; if a field does hold something new, it is kept.
 */
function clearSubmitted(form: HTMLFormElement, submitted: FieldValues) {
  const now = readFields(form);
  if (Object.keys(submitted).every((id) => now[id] === submitted[id])) {
    form.reset();
    return;
  }
  for (const el of Array.from(form.elements)) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement) || !el.id) continue;
    if (now[el.id] !== submitted[el.id]) continue;
    if (el instanceof HTMLSelectElement) {
      const initial = Array.from(el.options).find((o) => o.defaultSelected) ?? el.options[0];
      if (initial) el.value = initial.value;
    } else {
      el.value = "";
    }
  }
}

export function AttachmentForm({ workOrderId, components }: { workOrderId: string; components: Option[] }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [progress, setProgress] = useState<Progress[]>([]);
  const [busy, setBusy] = useState(false);

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    const bad = files.map((f) => [f, precheck(f)] as const).find(([, p]) => p);
    setProblem(bad ? `${bad[0].name}: ${bad[1]}` : null);
    setPicked((p) => ({ ...p, [e.target.id]: files.map((f) => f.name) }));
  }
  const names = Object.values(picked).flat();

  const update = (i: number, step: Step, message?: string) =>
    setProgress((list) => list.map((p, j) => (j === i ? { ...p, step, message } : p)));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (!files.length) {
      setProblem("Select at least one photo or file.");
      return;
    }
    const bad = files.map((f) => [f, precheck(f)] as const).find(([, p]) => p);
    if (bad) {
      setProblem(`${bad[0].name}: ${bad[1]}`);
      return;
    }
    const meta: UploadMeta = {
      category: String(fd.get("category") ?? ""),
      componentId: String(fd.get("component_id") ?? "") || null,
      note: String(fd.get("note") ?? "").trim() || null,
    };

    const submitted = readFields(form);
    setProblem(null);
    setBusy(true);
    setProgress(files.map((f) => ({ name: f.name, step: "waiting" })));

    let failed = 0;
    for (const [i, file] of files.entries()) {
      try {
        update(i, "uploading");
        const prep = await prepareUpload(workOrderId, meta, { name: file.name, type: file.type, size: file.size });
        if ("error" in prep) {
          failed++;
          update(i, "error", prep.error);
          continue;
        }
        const { error: upErr } = await browserClient()
          .storage.from("wo-files")
          .uploadToSignedUrl(prep.path, prep.token, file, { contentType: file.type });
        if (upErr) {
          failed++;
          update(i, "error", "Upload did not go through. Check your connection and try again.");
          continue;
        }
        update(i, "saving");
        const reg = await registerUpload(workOrderId, meta, prep.path, file.name);
        if (reg.error) {
          failed++;
          update(i, "error", reg.error);
          continue;
        }
        update(i, "done");
      } catch (err) {
        // A redirect (session ended) is already taking the browser to /login.
        if (isNextControlError(err)) {
          setBusy(false);
          return;
        }
        failed++;
        update(i, "error", "Upload did not go through. Check your connection and try again.");
      }
    }

    setBusy(false);
    if (!failed) {
      if (formRef.current) {
        clearSubmitted(formRef.current, submitted);
        const left = readFields(formRef.current);
        setPicked((p) => Object.fromEntries(Object.entries(p).filter(([id]) => left[id])));
      }
    } else {
      setProblem(
        failed === files.length
          ? "No files were added."
          : `${files.length - failed} of ${files.length} files were added. Select the failed ones again to retry.`,
      );
    }
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="uploadBox" id="attachment-form">
      {/* Locked while files upload, so nothing typed or picked meanwhile is lost. */}
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="field">
          <label htmlFor="att-category">Category</label>
          <select id="att-category" name="category" defaultValue="condition_damage">
            {Object.entries(ATTACHMENT_CATEGORY_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {components.length > 0 && (
          <div className="field">
            <label htmlFor="att-component">Linked component</label>
            <select id="att-component" name="component_id" defaultValue="">
              <option value="">Not linked to a component</option>
              {components.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <span className="small">Failed or condemned components need a photo linked here.</span>
          </div>
        )}
        <div className="field">
          <label htmlFor="att-camera">Take a photo</label>
          <input className="input" id="att-camera" name="files" type="file" accept="image/*" capture="environment" onChange={onPick} />
        </div>
        <div className="field">
          <label htmlFor="att-files">Photo / File</label>
          <input className="input" id="att-files" name="files" type="file" accept="image/*,.pdf" multiple onChange={onPick} />
          <span className="small">Photos or PDF, up to 25 MB each.</span>
        </div>
        {names.length > 0 && !busy && <p className="small">Selected: {names.join(", ")}</p>}
        <div className="field">
          <label htmlFor="att-note">Note</label>
          <input className="input" id="att-note" name="note" placeholder="Optional note" maxLength={2000} />
        </div>
      </fieldset>

      {progress.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 8px" }} aria-live="polite">
          {progress.map((p, i) => (
            <li key={`${i}-${p.name}`} className="small" style={{ padding: "3px 0", overflowWrap: "anywhere" }}>
              <strong>{p.name}</strong>:{" "}
              <span style={{ color: p.step === "error" ? "var(--red)" : p.step === "done" ? "var(--green2)" : undefined }}>
                {p.message ?? STEP_LABEL[p.step]}
              </span>
            </li>
          ))}
        </ul>
      )}
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn btn-blue" type="submit" disabled={busy} style={{ minHeight: 44 }}>
          {busy ? "Uploading..." : "Add Attachment"}
        </button>
      </div>
    </form>
  );
}
