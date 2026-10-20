import type { NextRequest } from "next/server";
import { quickBooksEntry } from "../entry";

/** Intuit's Launch URL: opens the QuickBooks connection in Admin > Settings. */
export async function GET(request: NextRequest) {
  return quickBooksEntry(request, "/cds/admin?tab=settings", "/cds/admin?tab=settings");
}
