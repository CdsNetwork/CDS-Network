"use client";

import { useState } from "react";
import { ActionForm } from "./ActionForm";
import type { ActionState } from "./types";

/** Decline with a required reason and a confirm step. The job goes back to CDS. */
export function DeclineJob({ action }: { action: (prev: ActionState, fd: FormData) => Promise<ActionState> }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="btn btn-danger" style={{ minHeight: 44 }} onClick={() => setOpen(true)}>
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
            placeholder="For example: no capacity this week, cannot service this component"
          />
        </div>
      </ActionForm>
    </div>
  );
}
