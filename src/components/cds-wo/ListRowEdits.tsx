"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { addInternalNote, addNote, setInternalStatus, setStatus } from "@/app/cds/work-orders/[id]/actions";
import { editInternalNote } from "@/app/cds/notes-actions";
import { setShipmentStatus } from "@/app/cds/shipping/actions";
import { INTERNAL_STATUS_LABEL, INTERNAL_STATUSES } from "@/lib/internal-status";
import { dateTime, SHIPMENT_STATUS_LABEL } from "@/lib/format";
import { NOTE_MAX_LENGTH } from "@/lib/notes";
import { ActionForm, type ActionState } from "./ActionForm";
import type { PopoverNote, PopoverNotes, StatusMove } from "./list-edits";
import type { ListLeg } from "./list-shipments";
import styles from "./cds-wo.module.css";

/**
 * Changes the order's status from the work order list: only the moves the work order page
 * offers for it (listStatusMoves), with the same confirmations. Same server action and
 * database rules as the order page; the change is logged on the order.
 */
export function ListStatusSelect({ woId, moves }: { woId: string; moves: StatusMove[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (moves.length === 0) return null;
  return (
    <div>
      <select
        className={styles.cellSelect}
        value=""
        disabled={pending}
        aria-label="Change status"
        onChange={(e) => {
          const move = moves.find((m) => m.status === e.target.value);
          if (!move) return;
          if (move.confirm && !window.confirm(move.confirm)) return;
          setError(null);
          startTransition(async () => {
            const res = await setStatus(woId, move.status, {}, new FormData());
            if (res.error) setError(res.error);
          });
        }}
      >
        <option value="">{pending ? "Saving..." : "Change status"}</option>
        {moves.map((m) => (
          <option key={m.status} value={m.status}>
            {m.label}
          </option>
        ))}
      </select>
      {error && (
        <p className={`error ${styles.cellError}`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Sets the CDS-only internal status on change, in the work order list and on the order page
 * (same server action; logged on the order as a CDS-only event). Shops never see it.
 * Pass `id` and `className` when a visible label points at the select.
 */
export function ListInternalStatusSelect({
  woId,
  value,
  id,
  className,
}: {
  woId: string;
  value: string | null;
  id?: string;
  className?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [shown, setShown] = useState(value ?? "");
  // A saved change from elsewhere (the page reloads with a new value) resets the select.
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setShown(value ?? "");
  }

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(t);
  }, [saved]);

  return (
    <div>
      <select
        id={id}
        className={className ?? `${styles.cellSelect} ${shown ? styles.cellSelectSet : ""}`}
        value={shown}
        disabled={pending}
        aria-label="Internal status (CDS only)"
        title="Internal status (CDS only)"
        onChange={(e) => {
          const next = e.target.value;
          const before = shown;
          setShown(next);
          setError(null);
          setSaved(false);
          const fd = new FormData();
          fd.set("internal_status", next);
          startTransition(async () => {
            const res = await setInternalStatus(woId, {}, fd);
            if (res.error) {
              setShown(before);
              setError(res.error);
            } else {
              setSaved(true);
            }
          });
        }}
      >
        <option value="">No internal status</option>
        {INTERNAL_STATUSES.map((v) => (
          <option key={v} value={v}>
            {INTERNAL_STATUS_LABEL[v]}
          </option>
        ))}
      </select>
      <div role="status" className="small" style={saved && !pending ? { color: "#3b6d12", fontWeight: 700 } : undefined}>
        {pending ? "Saving..." : saved ? "Saved" : null}
      </div>
      {error && (
        <p className={`error ${styles.cellError}`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The carrier status of one shipment leg in the work order list, saved on change with the
 * Shipping page's action and statuses (setShipmentStatus). "In" goes to the shop or CDS,
 * "Out" back to the customer; the tooltip names the full direction, carrier and tracking.
 */
export function ListShipmentStatusSelect({ leg }: { leg: ListLeg }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [shown, setShown] = useState(leg.status);
  // A saved change from elsewhere (tracking or the Shipping page) resets the select.
  const [lastValue, setLastValue] = useState(leg.status);
  if (leg.status !== lastValue) {
    setLastValue(leg.status);
    setShown(leg.status);
  }

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(t);
  }, [saved]);

  return (
    <div className={styles.legRow}>
      <div className={styles.legLine}>
        <span className={styles.legDir} title={leg.title}>
          {leg.dir}
        </span>
        <select
          className={styles.cellSelect}
          value={shown}
          disabled={pending}
          aria-label={`Shipment status, ${leg.title}`}
          title={leg.title}
          onChange={(e) => {
            const next = e.target.value;
            const before = shown;
            setShown(next);
            setError(null);
            setSaved(false);
            const fd = new FormData();
            fd.set("status", next);
            startTransition(async () => {
              const res = await setShipmentStatus(leg.id, {}, fd);
              if (res.error) {
                setShown(before);
                setError(res.error);
              } else {
                setSaved(true);
              }
            });
          }}
        >
          {Object.entries(SHIPMENT_STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {leg.trackingUrl && (
          <a className="link small" href={leg.trackingUrl} target="_blank" rel="noreferrer" title={leg.title}>
            Track
          </a>
        )}
      </div>
      <div role="status" className="small" style={saved && !pending ? { color: "#3b6d12", fontWeight: 700 } : undefined}>
        {pending ? "Saving..." : saved ? "Saved" : null}
      </div>
      {error && (
        <p className={`error ${styles.cellError}`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const PANEL_WIDTH = 380;
const HOVER_OPEN_MS = 300;
const HOVER_CLOSE_MS = 250;

type Loaded = { notes: PopoverNotes } | { error: string };

/**
 * Notes of one order from the work order list: hover the Notes button (mouse) to read them,
 * click or tap it to keep the panel open and add or edit. Loaded only when the panel opens.
 * Internal notes are CDS only; notes the shop sees are marked as such, as on the order page.
 */
export function ListNotesButton({ woId, label, count }: { woId: string; label: string; count: number }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [pos, setPos] = useState<CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelId = useId();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/cds/work-orders/${woId}/notes`, { cache: "no-store" });
      const body = await res.json();
      setLoaded(res.ok ? { notes: body as PopoverNotes } : { error: (body as { error?: string }).error ?? "Notes could not be loaded." });
    } catch {
      setLoaded({ error: "Notes could not be loaded. Try again." });
    }
  }, [woId]);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const show = useCallback(() => {
    setOpen(true);
    void load();
  }, [load]);

  const close = useCallback(() => {
    clearTimer();
    setOpen(false);
    setPinned(false);
  }, []);

  // Place the panel under the button, or above it near the bottom of the window.
  const lastRect = useRef("");
  const place = useCallback(() => {
    const b = buttonRef.current?.getBoundingClientRect();
    if (!b) return;
    const key = `${b.left},${b.top},${b.bottom},${window.innerWidth},${window.innerHeight}`;
    if (key === lastRect.current) return;
    lastRect.current = key;
    const width = Math.min(PANEL_WIDTH, window.innerWidth - 16);
    const left = Math.max(8, Math.min(b.left, window.innerWidth - width - 8));
    const below = window.innerHeight - b.bottom;
    setPos(
      below > 320 || below > b.top
        ? { top: b.bottom + 6, left, width, maxHeight: Math.max(160, below - 16) }
        : { bottom: window.innerHeight - b.top + 6, left, width, maxHeight: Math.max(160, b.top - 16) },
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    lastRect.current = "";
    place();
    // Follow the button while open: scrolling, resizing, and rows added above it when the list refreshes.
    let frame = requestAnimationFrame(function follow() {
      place();
      frame = requestAnimationFrame(follow);
    });
    return () => cancelAnimationFrame(frame);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        buttonRef.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !buttonRef.current?.contains(t)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open, close]);

  useEffect(() => clearTimer, []);

  // Hover (mouse only; a tap opens it with the click below).
  const enter = (e: ReactPointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clearTimer();
    if (!open) timer.current = setTimeout(show, HOVER_OPEN_MS);
  };
  const leave = (e: ReactPointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clearTimer();
    if (pinned) return;
    timer.current = setTimeout(() => {
      if (panelRef.current?.contains(document.activeElement)) return;
      setOpen(false);
    }, HOVER_CLOSE_MS);
  };

  const afterSave = async (res: ActionState) => {
    if (!res.error) await load();
    return res;
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles.notesButton}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onPointerEnter={enter}
        onPointerLeave={leave}
        onClick={() => {
          clearTimer();
          if (open && pinned) close();
          else {
            setPinned(true);
            if (!open) show();
          }
        }}
      >
        Notes{count > 0 ? ` (${count})` : ""}
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={`${label} notes`}
          className={styles.notesPanel}
          style={pos}
          onPointerEnter={enter}
          onPointerLeave={leave}
          onFocus={() => setPinned(true)}
        >
          <div className="row between" style={{ gap: 8 }}>
            <b>{label} notes</b>
            <span className="row" style={{ gap: 10 }}>
              <Link className={`link small ${styles.linkButton}`} href={`/cds/work-orders/${woId}#internal-notes`}>
                Open order
              </Link>
              <button type="button" className={`link small ${styles.linkButton}`} onClick={close} aria-label="Close notes">
                Close
              </button>
            </span>
          </div>
          {!loaded ? (
            <p className="small">Loading...</p>
          ) : "error" in loaded ? (
            <p className="error" role="alert">
              {loaded.error}
            </p>
          ) : (
            <>
              <h4 className={styles.notesHeading}>Internal notes (CDS only)</h4>
              <NoteItems woId={woId} notes={loaded.notes.internal} afterSave={afterSave} />
              <ActionForm
                action={async (prev, fd) => afterSave(await addInternalNote(woId, prev, fd))}
                submitLabel="Add internal note"
                pendingLabel="Adding..."
                buttonClass="btn btn-secondary btn-small"
                resetOnSuccess
              >
                <textarea
                  name="body"
                  rows={2}
                  maxLength={NOTE_MAX_LENGTH}
                  required
                  aria-label="New internal note (CDS only)"
                  placeholder="New internal note (CDS only)"
                  className={styles.notesTextarea}
                />
              </ActionForm>

              <h4 className={styles.notesHeading}>Notes (shop can see)</h4>
              <NoteItems woId={woId} notes={loaded.notes.shared} afterSave={afterSave} />
              <details>
                <summary className="small link">Add a note the shop sees</summary>
                <ActionForm
                  action={async (prev, fd) => afterSave(await addNote(woId, prev, fd))}
                  submitLabel="Add note"
                  pendingLabel="Adding..."
                  buttonClass="btn btn-secondary btn-small"
                  resetOnSuccess
                >
                  <textarea
                    name="body"
                    rows={2}
                    maxLength={NOTE_MAX_LENGTH}
                    required
                    aria-label="New note (the shop sees it)"
                    placeholder="New note (the shop sees it)"
                    className={styles.notesTextarea}
                  />
                </ActionForm>
              </details>
            </>
          )}
        </div>
      )}
    </>
  );
}

function NoteItems({
  woId,
  notes,
  afterSave,
}: {
  woId: string;
  notes: PopoverNote[];
  afterSave: (res: ActionState) => Promise<ActionState>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  if (notes.length === 0) return <p className="small">No notes yet.</p>;
  return (
    <div className={styles.notesList}>
      {notes.map((n) => (
        <div key={n.id} className={styles.noteItem}>
          <div className="row between" style={{ gap: 8, alignItems: "flex-start" }}>
            <span className="small">
              <b>{n.author_name}</b> · {dateTime(n.created_at)}
              {n.edited_at && <> · edited {dateTime(n.edited_at)}</>}
            </span>
            {n.editable && editing !== n.id && (
              <button type="button" className={`link small ${styles.linkButton}`} onClick={() => setEditing(n.id)}>
                Edit
              </button>
            )}
          </div>
          {editing === n.id ? (
            <ActionForm
              action={async (prev, fd) => {
                const res = await editInternalNote(woId, n.id, prev, fd);
                if (!res.error) setEditing(null);
                return afterSave(res);
              }}
              submitLabel="Save"
              buttonClass="btn btn-secondary btn-small"
              inline
            >
              <textarea
                name="body"
                rows={3}
                maxLength={NOTE_MAX_LENGTH}
                required
                defaultValue={n.body}
                aria-label="Edit note"
                className={styles.notesTextarea}
                autoFocus
                onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
              />
              <button type="button" className={`link small ${styles.linkButton}`} onClick={() => setEditing(null)}>
                Cancel
              </button>
            </ActionForm>
          ) : (
            <div className={styles.noteBody}>{n.body}</div>
          )}
        </div>
      ))}
    </div>
  );
}
