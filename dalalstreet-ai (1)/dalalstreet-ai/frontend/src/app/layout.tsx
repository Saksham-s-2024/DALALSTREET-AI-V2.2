import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-plex-mono",
});

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-plex-sans",
});

export const metadata: Metadata = {
  title: "DalalStreet AI — Indian Market Intelligence",
  description: "AI-powered intraday risk assessment and long-term investment recommendations for the Indian stock market.",
  keywords: ["NSE", "BSE", "Indian stock market", "intraday trading", "mutual funds", "ETF", "AI trading"],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plexMono.variable} ${plexSans.variable}`}>
      <body className={plexMono.className} style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
