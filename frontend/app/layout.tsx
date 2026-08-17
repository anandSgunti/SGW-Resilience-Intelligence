import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import WorkflowNav from "./WorkflowNav";
import { IncidentProvider } from "./IncidentContext";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "SGW Resilience Command",
  description: "Operational resilience intelligence for connected infrastructure.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable}`}><IncidentProvider><WorkflowNav /><div className="workflow-content">{children}</div></IncidentProvider><style>{`.workflow-content{min-height:100vh}`}</style></body></html>;
}
