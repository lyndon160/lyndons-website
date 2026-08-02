import type { Metadata, Viewport } from "next";
import { ServiceWorkerRegistration } from "./components/ServiceWorkerRegistration";
import "./globals.css";

const siteUrl = "https://colour.lyndonfawcett.com";
const socialImage = `${siteUrl}/og.png`;

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Colour in Photo — Make your own colour-by-numbers",
  description:
    "Turn any photo into a calm, playable colour-by-numbers canvas. Your photo is processed privately on your device.",
  applicationName: "Colour in Photo",
  manifest: "/manifest.webmanifest",
  alternates: {
    canonical: siteUrl,
  },
  keywords: [
    "colour by numbers",
    "photo game",
    "Apple Pencil",
    "creative game",
  ],
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Colour in Photo",
  },
  openGraph: {
    title: "Colour in Photo",
    description: "Turn a favourite photo into a colour-by-numbers canvas.",
    type: "website",
    url: siteUrl,
    siteName: "Colour in Photo",
    images: [{ url: socialImage, width: 1731, height: 909 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Colour in Photo",
    description: "Turn a favourite photo into a colour-by-numbers canvas.",
    images: [socialImage],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f2ede3",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
