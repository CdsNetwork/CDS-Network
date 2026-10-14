import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CDS Network Portal",
  description: "Clean Diesel Specialists work orders for CDS staff and network shops",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
