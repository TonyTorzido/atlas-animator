/*
 * Atlas Animator: original implementation.
 *
 * Swag rules pack: the template types and the shared paths (see packages/animator/swag-rules).
 */
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SWAG_TYPES = ["simple", "medium", "hard-plate", "headwear", "hanging-cloth", "held-item"] as const;
export type SwagType = (typeof SWAG_TYPES)[number];
/** Types with their own pipeline (rules, prompt, guide, checks, import gates); the others are stubs. */
export const SWAG_READY: readonly SwagType[] = ["simple", "medium", "hard-plate", "held-item"];
/**
 * Deprecated type names that still resolve (owner): `fitted-cloth` was renamed `simple` (the body-derived
 * thin template, used by every armour class). Old commands keep working; the CLIs print a deprecation note.
 */
export const SWAG_TYPE_ALIASES: Readonly<Record<string, SwagType>> = { "fitted-cloth": "simple" };
export const DEFAULT_HELD = fileURLToPath(new URL("../../fixtures/garments/sword.held.json", import.meta.url));
export const DEFAULT_PLATE = fileURLToPath(new URL("../../fixtures/garments/pauldron.plate.json", import.meta.url));

export const SWAG_RULES_DIR = fileURLToPath(new URL("../../swag-rules/", import.meta.url));
const BODY_RIG_DIR = fileURLToPath(new URL("../../fixtures/test-rigs/body/", import.meta.url));
/** The committed body rig (the one non-bare.anim.json of the body folder); found by listing, no template name here. */
export const DEFAULT_BODY_RIG = ((): string => {
  const f = existsSync(BODY_RIG_DIR) ? readdirSync(BODY_RIG_DIR).find((n) => n.endsWith(".anim.json") && !n.endsWith(".bare.anim.json")) : undefined;
  return `${BODY_RIG_DIR}${f ?? "body.anim.json"}`;
})();
export const DEFAULT_DOMAIN = fileURLToPath(new URL("../../fixtures/garments/kungfu-jacket-shortcuff.domain.json", import.meta.url)); // the simple-template guide keeps the short-cuff surface (unchanged by the  jacket default swap)

/** The medium-template guide and default domain: the padded gambeson (long cuffs, margin 11). */
export const DEFAULT_MEDIUM_DOMAIN = fileURLToPath(new URL("../../fixtures/garments/medium-gambeson.domain.json", import.meta.url));
/** The default domain of a body-derived template type. */
export const defaultDomainFor = (type: SwagType): string => (type === "medium" ? DEFAULT_MEDIUM_DOMAIN : DEFAULT_DOMAIN);
/**
 * A body-derived template type and its domain must agree: a medium domain (`template: "medium"`) only
 * through `--type medium`, a simple one only through `--type simple`. Returns the problem, or null.
 */
export function domainTemplateMismatch(type: SwagType, domain: { template?: string }): string | null {
  if (type !== "simple" && type !== "medium") return null;
  const t = domain.template ?? "simple";
  return t === type ? null : `the domain is a ${t}-template domain but --type is ${type}; use --type ${t} or a ${type} domain`;
}

export const isSwagType = (s: string): s is SwagType => (SWAG_TYPES as readonly string[]).includes(s);
/** The canonical type for a `--type` value (aliases resolved), the alias used (if any), or null when unknown. */
export function resolveSwagType(s: string): { type: SwagType; alias?: string } | null {
  if (isSwagType(s)) return { type: s };
  const t = SWAG_TYPE_ALIASES[s];
  return t ? { type: t, alias: s } : null;
}
/** Resolves `--type` (default `simple`); writes the deprecation note for an alias. Null (after the error) when unknown. */
export function swagTypeFlag(flags: Flags, err: (msg: string) => void): SwagType | null {
  const raw = flagStr(flags, "type") ?? "simple";
  const r = resolveSwagType(raw);
  if (!r) { err(`unknown --type ${raw}; one of ${SWAG_TYPES.join(", ")}
`); return null; }
  if (r.alias) err(`note: --type ${r.alias} is deprecated; use --type ${r.type}
`);
  return r.type;
}


export type Flags = Map<string, string | true>;

export function parseArgs(args: readonly string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags.set(a.slice(2), next); i++; } else flags.set(a.slice(2), true);
    } else positional.push(a);
  }
  return { positional, flags };
}

export const flagStr = (flags: Flags, name: string): string | undefined => {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
};
