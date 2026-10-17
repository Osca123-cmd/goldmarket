// Salin modul inti (src/core) ke supabase/functions/_shared/core agar
// Edge Function memakai kode analisis yang sama persis dengan frontend & test.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "supabase/functions/_shared/core");
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(join(root, "src/core"), dest, { recursive: true });
console.log("core disalin ke", dest);
