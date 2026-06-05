import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sync2Music",
  description:
    "Listen to music playing in the room, identify it, and play the same song from the same position — synced with the live audio.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
