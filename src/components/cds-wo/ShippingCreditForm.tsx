import { setShopShippingCredit } from "@/app/cds/work-orders/[id]/actions";
import { SHIPPING_CREDIT_HELP } from "@/lib/shop-deductions";
import { ActionForm } from "./ActionForm";

/**
 * The "Shipping credit from shop" checkbox (work_order_internal.shop_shipping_credit), under the
 * order's lines and in the Shop bill box while the bill waits for approval. Keyed by the saved
 * value: after a save the page is revalidated and every copy starts again from what was saved.
 */
export function ShippingCreditForm({ woId, on, idSuffix }: { woId: string; on: boolean; idSuffix: string }) {
  const inputId = `shop-shipping-credit-${idSuffix}`;
  return (
    <ActionForm
      key={`shipping-credit-${on ? "on" : "off"}`}
      action={setShopShippingCredit.bind(null, woId)}
      submitLabel="Save"
      buttonClass="btn btn-secondary btn-small"
      inline
    >
      <div className="field">
        <label className="row" htmlFor={inputId} style={{ gap: 8, fontWeight: 600 }}>
          <input id={inputId} type="checkbox" name="shop_shipping_credit" defaultChecked={on} style={{ width: "auto" }} /> Shipping
          credit from shop
        </label>
        <div className="small">{SHIPPING_CREDIT_HELP}</div>
      </div>
    </ActionForm>
  );
}
