"use client";

import { useEffect } from "react";
import { markWorkOrderSeen } from "@/app/cds/work-orders/[id]/actions";

/**
 * Clears the work order's "New from shop" flag once CDS actually has the page open. It runs in
 * the browser after the page is shown, so prefetching a link to the work order does not count
 * as opening it. Renders nothing.
 */
export function MarkSeen({ workOrderId }: { workOrderId: string }) {
  useEffect(() => {
    markWorkOrderSeen(workOrderId).catch(() => {
      // Best effort: the flag stays on and clears the next time the order is opened.
    });
  }, [workOrderId]);
  return null;
}
