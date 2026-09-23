import { extractText } from "../src/lib/documents";

// Точка входа смоука: только бандл и файл на диске — как в проде.
const [file] = process.argv.slice(2);
const doc = await extractText(file!, "application/pdf", "smoke.pdf");
console.log(`SMOKE_RESULT ${JSON.stringify(doc)}`);
