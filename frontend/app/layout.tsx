import type { Metadata } from "next";
import { Space_Grotesk, DM_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import WorkflowNav from "./WorkflowNav";
import { IncidentProvider } from "./IncidentContext";

const display = Space_Grotesk({ variable: "--font-space-grotesk", subsets: ["latin"] });
const sans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"] });
const mono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: "SGW Resilience Command",
  description: "Operational resilience intelligence for connected infrastructure.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${display.variable} ${sans.variable} ${mono.variable}`}><IncidentProvider><WorkflowNav /><div className="workflow-content">{children}</div></IncidentProvider><style>{`.workflow-content{min-height:100vh}`}</style></body></html>;
}
