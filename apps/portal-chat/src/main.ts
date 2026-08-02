import { createApp } from "./components/chat-view.js";
import "./styles/main.css";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("No #app element found");
}

async function loadVersion(): Promise<string> {
  try {
    const res = await fetch("/version.json");
    const data = (await res.json()) as { commit?: string };
    return data.commit || "unknown";
  } catch {
    return "unknown";
  }
}

loadVersion().then((version) => createApp(app, version)).catch(console.error);
