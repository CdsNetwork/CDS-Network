/**
 * The test-mode note said UPS refuses test labels, but on production (2026-11-04, WO 101659)
 * UPS by Worldwide Express (WWEX) created a test label; only FedEx refused. The note must
 * not tell staff that UPS refuses.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILES = ["src/components/shipping/LabelPanel.tsx", "src/components/shipping/ShippingSettings.tsx"];

describe("test label note", () => {
  for (const file of FILES) {
    it(`${file} says FedEx refuses and UPS (WWEX) works`, () => {
      const src = readFileSync(file, "utf8");
      expect(src).not.toContain("FedEx and UPS refuse test labels");
      expect(src).toContain("FedEx refuses test labels; UPS (WWEX) and USPS accept them.");
    });
  }
});
