import path from "node:path";
import ExcelJS from "exceljs";

type CellAddr = { r: number; c: number };

function colName(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

function cellLabel(a: CellAddr): string {
  return `${colName(a.c)}${a.r}`;
}

function normalizeValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && (v as any).richText) return "[richText]";
  if (typeof v === "object" && (v as any).formula) return `=${(v as any).formula}`;
  return String(v);
}

async function inspect(file: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  process.stdout.write(`\n=== ${path.basename(file)} ===\n`);
  process.stdout.write(`sheets: ${wb.worksheets.map((w) => w.name).join(", ")}\n`);
  for (const ws of wb.worksheets) {
    const dims = ws.dimensions;
    process.stdout.write(`\n-- sheet: ${ws.name}\n`);
    process.stdout.write(`range: ${cellLabel({ r: dims.top, c: dims.left })}:${cellLabel({ r: dims.bottom, c: dims.right })}\n`);
    const headerRows = [dims.top, dims.top + 1, dims.top + 2].filter((r) => r <= dims.bottom);
    for (const r of headerRows) {
      const vals: string[] = [];
      for (let c = dims.left; c <= Math.min(dims.right, dims.left + 12); c++) {
        vals.push(normalizeValue(ws.getCell(r, c).value));
      }
      process.stdout.write(`${r}: ${vals.join(" | ")}\n`);
    }
    const merges = Array.from((ws as any)._merges?.keys?.() ?? []);
    process.stdout.write(`merges: ${merges.length}\n`);
    const widths: Array<{ col: number; width: number | undefined }> = [];
    for (let c = dims.left; c <= dims.right; c++) {
      const w = ws.getColumn(c).width;
      widths.push({ col: c, width: typeof w === "number" ? w : undefined });
    }
    const widthStr = widths
      .filter((x) => x.width !== undefined)
      .slice(0, 20)
      .map((x) => `${colName(x.col)}=${x.width}`)
      .join(", ");
    process.stdout.write(`widths(sample): ${widthStr}\n`);

    process.stdout.write(`\nrows:\n`);
    for (let r = dims.top; r <= dims.bottom; r++) {
      const vals: string[] = [];
      for (let c = dims.left; c <= dims.right; c++) {
        vals.push(normalizeValue(ws.getCell(r, c).value));
      }
      process.stdout.write(`${r}: ${vals.join(" | ")}\n`);
    }
  }
}

async function main() {
  const root = path.resolve(process.cwd(), "docs", "templates");
  await inspect(path.join(root, "Jinweide_Sdn_Bhd_-_Profit_and_Loss.xlsx"));
  await inspect(path.join(root, "Jinweide_Sdn_Bhd_-_Balance_Sheet.xlsx"));
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e?.message || e) + "\n");
  process.exit(1);
});
