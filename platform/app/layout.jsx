import "./globals.css";
import { STUDY_TITLE } from "../lib/branding";

export const metadata = {
  title: STUDY_TITLE,
  description: "A rigorous clinician workspace for annotating real clinical queries.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
