"use client";

import { useState } from "react";
import { ActionForm } from "./ActionForm";
import styles from "./shop.module.css";
import type { ActionState } from "./types";

/**
 * Decline with a required reason and a confirm step. The job goes back to CDS.
 * `small` shows a quiet text button, for accepted jobs where Decline is no longer the main choice.
 */
export function DeclineJob({
  action,
  small = false,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        className={small ? styles.textButton : "btn btn-danger"}
        style={{ minHeight: 44 }}
        onClick={() => setOpen(true)}
      >
        Decline Job
      </button>
    );
  }
  return (
    <div className="notice danger" style={{ width: "100%" }}>
      <strong>Decline this job?</strong>
      <p className="small" style={{ color: "inherit", margin: "4px 0 10px" }}>
        The job goes back to CDS to be reassigned and will disappear from your queue.
      </p>
      <ActionForm
        action={action}
        submitLabel="Confirm Decline"
        pendingLabel="Declining..."
        submitClass="btn btn-danger"
        footer={
          <button type="button" className="btn btn-secondary" style={{ minHeight: 44 }} onClick={() => setOpen(false)}>
            Cancel
          </button>
        }
      >
        <div className="field">
          <label htmlFor="decline-reason">
            Reason for declining <span className="req">*</span>
          </label>
          <textarea
            id="decline-reason"
            name="reason"
            rows={3}
            required
            maxLength={2000}
            placeholder="For example: no capacity this week, cannot service this component"
          />
        </div>
      </ActionForm>
    </div>
  );
}
