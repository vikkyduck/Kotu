import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Файл, брошенный мимо зон загрузки, браузер открыл бы сам — вместо
// приложения. Зоны отменяют это действие сами, здесь — всё остальное.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (e) => {
    if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });
}

createRoot(document.getElementById("root")!).render(<App />);
