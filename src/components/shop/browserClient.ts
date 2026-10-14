"use client";

import { createBrowserClient } from "@supabase/ssr";

let client: ReturnType<typeof createBrowserClient> | null = null;

/**
 * Browser Supabase client, used only to send files to a signed upload URL that the
 * server prepared. All reads and every other write go through the server.
 */
export function browserClient() {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error("Supabase is not configured");
    client = createBrowserClient(url, key);
  }
  return client;
}
