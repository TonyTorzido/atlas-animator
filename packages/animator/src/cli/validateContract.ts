/*
 * Atlas Animator: `animator validate --contract <rig.anim.json> [--contract-file <CONTRACT.json>] [--json]` (Batch 10b).
 *
 * Checks a rig against the swag contract: every contract bone and core slot exists, the weapon grip / tip points exist (or the legacy
 * weapon bones that stand in for them), and every slot rides the bone the contract names. The contract is the editor's `rigContract.ts`
 * (the file form is `CONTRACT.json`); a `CONTRACT.json` beside the rig (or `--contract-file`) is read too: it must itself be sound
 * (`validateContract`) and the rig is checked against ITS bones, slots and points, so a rig v2 contract can replace the legacy one.
 * Exit 0 = wearable, 1 = something missing or wrong.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type Json = Record<string, unknown>;
const list = (v: unknown): Json[] => (Array.isArray(v) ? (v.filter((x) => typeof x === "object" && x !== null) as Json[]) : []);

export interface ContractReport {
  rig: string;
  contract: string;
  problems: string[];
  missingBones: string[];
  missingSlots: string[];
  wrongBone: string[];
  missingPoints: string[];
  ok: boolean;
}

/** Pure check of a rig document against contract data (bones / slots / points as in `CONTRACT.json`). */
export function checkAgainstContract(raw: Json, contract: Json): Omit<ContractReport, "rig" | "contract" | "problems" | "ok"> {
  const bones = new Set(list(raw["bones"]).map((b) => String(b["name"])));
  const slots = new Map(list(raw["slots"]).map((s) => [String(s["name"]), String(s["bone"])] as const));
  const missingBones = list(contract["bones"]).map((b) => String(b["name"])).filter((n) => !bones.has(n));
  const core = list(contract["slots"]).filter((s) => s["onDemand"] !== true);
  const missingSlots = core.map((s) => String(s["name"])).filter((n) => !slots.has(n));
  const wrongBone = list(contract["slots"])
    .filter((s) => slots.has(String(s["name"])) && slots.get(String(s["name"])) !== String(s["bone"]))
    .map((s) => `${String(s["name"])} rides ${slots.get(String(s["name"]))}, the contract says ${String(s["bone"])}`);
  const hasPoint = (name: string): boolean =>
    Object.values((raw["skins"] ?? {}) as Record<string, Json>).some((sk) => Object.values((sk["attachments"] ?? {}) as Record<string, Json>).some((byName) => (byName[name] as Json | undefined)?.["type"] === "point"));
  const missingPoints = list(contract["points"])
    .filter((p) => !hasPoint(String(p["name"])) && !bones.has(String(p["legacyBone"] ?? p["bone"])))
    .map((p) => String(p["name"]));
  return { missingBones, missingSlots, wrongBone, missingPoints };
}

export async function validateContractCommand(rigArg: string, flags: Map<string, string | true>): Promise<number> {
  const rigPath = resolve(rigArg);
  if (!existsSync(rigPath)) {
    process.stderr.write(`animator validate --contract: no such rig ${rigArg}\n`);
    return 2;
  }
  // Dynamic, so the engine CLI does not load the editor package unless a contract is asked for.
  const editor = (await import("../../../animator-editor/src/rigContract.js")) as { contractJson(): Json; validateContract(file: unknown): string[] };
  const raw = JSON.parse(readFileSync(rigPath, "utf8")) as Json;
  const fileFlag = flags.get("contract-file");
  const besidePath = join(dirname(rigPath), "CONTRACT.json");
  const filePath = typeof fileFlag === "string" ? resolve(fileFlag) : existsSync(besidePath) ? besidePath : null;
  const problems: string[] = [];
  let contract: Json = editor.contractJson();
  let label = `built-in ${String(contract["id"])} r${String(contract["revision"])}`;
  if (filePath) {
    if (!existsSync(filePath)) {
      process.stderr.write(`animator validate --contract: no such contract file ${filePath}\n`);
      return 2;
    }
    contract = JSON.parse(readFileSync(filePath, "utf8")) as Json;
    problems.push(...editor.validateContract(contract).map((p) => `CONTRACT.json: ${p}`));
    label = `${filePath} (${String(contract["id"])} r${String(contract["revision"])})`;
  }
  const found = checkAgainstContract(raw, contract);
  const ok = problems.length === 0 && !found.missingBones.length && !found.missingSlots.length && !found.wrongBone.length && !found.missingPoints.length;
  const report: ContractReport = { rig: rigPath, contract: label, problems, ...found, ok };
  if (flags.get("json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    const out = [`contract: ${label}`, `rig: ${rigPath}`];
    for (const p of problems) out.push(`  problem: ${p}`);
    for (const n of found.missingBones) out.push(`  missing bone: ${n}`);
    for (const n of found.missingSlots) out.push(`  missing slot: ${n}`);
    for (const n of found.wrongBone) out.push(`  wrong bone: ${n}`);
    for (const n of found.missingPoints) out.push(`  missing point: ${n}`);
    out.push(ok ? "contract ok: swag fits this rig" : "contract FAILED");
    process.stdout.write(`${out.join("\n")}\n`);
  }
  return ok ? 0 : 1;
}
