import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Merlin 1D — Hand Control",
  description:
    "Turn, spin, catch and zoom a Merlin 1D rocket engine with your hands through your webcam.",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2303070c'/%3E%3Cpath d='M11 6h10l-1 6h-8zM12 12h8l3 14H9z' fill='none' stroke='%2366d9ff' stroke-width='1.6' stroke-linejoin='round'/%3E%3C/svg%3E",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#03070c",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body data-ui="full" className="booting" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
