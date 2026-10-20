import type { NextRequest } from "next/server";
import { quickBooksEntry } from "../entry";

/** Intuit's Connect/Reconnect URL: starts the QuickBooks OAuth flow (/cds/quickbooks/connect). */
export async function GET(request: NextRequest) {
  return quickBooksEntry(request, "/cds/quickbooks/connect", "/quickbooks/connect");
}
