import type { Metadata } from "next";
import { Instrument_Sans, Newsreader } from "next/font/google";
import ResearchApp from "./research-app";
import "./research.css";

const uiFont = Instrument_Sans({ subsets: ["latin"], variable: "--font-ui" });
const readFont = Newsreader({ subsets: ["latin"], variable: "--font-read" });

export const metadata: Metadata = {
  title: "Researcher | Startage",
  description: "Research a business idea: customers, competitors, prices, and what could get in the way.",
};

export default function ResearchPage() {
  return (
    <div className={`${uiFont.variable} ${readFont.variable} rs-root`}>
      <ResearchApp />
    </div>
  );
}
