import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TM Academy · AI Operations",
  description: "Conversation, knowledge, and AI operations platform"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
