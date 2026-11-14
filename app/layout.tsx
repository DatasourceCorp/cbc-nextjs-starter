import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { getConfig } from "../lib/config.ts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Volunteer screening | Christian Background Checks starter",
  description: "Starter app for the Christian Background Checks Partner API",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const config = getConfig();
  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="inner">
            <Link href="/" className="brand">
              Volunteer screening
            </Link>
            <nav>
              <Link href="/">Church</Link>
              <Link href="/checks/new">Order a check</Link>
              <Link href="/checks">Checks</Link>
              <Link href="/settings">Webhooks</Link>
            </nav>
            <span className="env muted">
              {config.isSandbox ? "Sandbox" : "Production"}: <code>{config.baseUrl}</code>
            </span>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
