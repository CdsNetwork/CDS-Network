import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * The label PDF. CDS sees every label, a shop only the labels on its own work orders
 * (the shipment_labels policies decide; the file is then read with the service role).
 * A voided label answers 410 Gone.
 */
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return new NextResponse("Not found", { status: 404 });
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Sign in first", { status: 401 });

  const { data: label } = await supabase
    .from("shipment_labels")
    .select("id, label_file_path, label_url, tracking_number, is_test, status")
    .eq("id", id)
    .maybeSingle();
  if (!label) return new NextResponse("Not found", { status: 404 });
  // A voided label must not be printed and shipped on.
  if (label.status !== "active") return new NextResponse("This label was voided. Ask CDS for a new label.", { status: 410 });

  const name = `${label.is_test ? "TEST-" : ""}label-${(label.tracking_number ?? label.id).replace(/[^A-Za-z0-9-]/g, "")}.pdf`;
  if (label.label_file_path) {
    const { data: file } = await createAdminClient().storage.from("wo-files").download(label.label_file_path);
    if (file) {
      return new NextResponse(file.stream(), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${name}"`,
          "Cache-Control": "private, no-store",
        },
      });
    }
  }
  if (label.label_url?.startsWith("https://")) return NextResponse.redirect(label.label_url, 302);
  return new NextResponse("The label file is not available. Ask CDS to reprint it.", { status: 404 });
}
