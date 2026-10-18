/** Confirm text for voiding a label: a real label states what voiding it means. */
export function voidLabelConfirm(label: { is_test: boolean; carrier: string | null; tracking_number: string | null }): string {
  if (label.is_test) return "Void this test label?";
  const which = [label.carrier, label.tracking_number].filter(Boolean).join(" ");
  return (
    `Void the ${which ? `${which} ` : ""}label in ShipStation? It can no longer be used to ship, so do not send a package ` +
    "with it. The carrier refunds the postage later. This cannot be undone: a new label must be bought to ship this leg."
  );
}
