/**
 * Shop updates on the CDS work order list (20261111040000_shop_updates.sql). Safe on server
 * and client.
 *
 * "New from shop": the shop accepted the job, changed its pickup ETA, added a note, uploaded a
 * file, or marked a component failed since CDS last opened the work order
 * (20261111080000_shop_accept_activity.sql adds accepting and the ETA). A failed or condemned component shows on the list row
 * whatever the order's status is.
 */
import { one } from "./util";

/** Query string parameter of the "New from shop" filter ("1" turns it on). */
export const FROM_SHOP_PARAM = "from_shop";

type Activity = { is_new: boolean | null } | null;

export function isNewFromShop(activity: Activity | Activity[] | undefined): boolean {
  return Boolean(one(activity ?? null)?.is_new);
}

/** "Condemned" when a component was condemned ("Failed" is no longer a result), else null. */
export function failedMark(components: { result: string | null }[] | null | undefined): "Condemned" | null {
  return (components ?? []).some((c) => c.result === "condemned") ? "Condemned" : null;
}
