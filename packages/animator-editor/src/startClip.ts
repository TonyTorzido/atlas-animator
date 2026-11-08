/** Which clip a rig opens on: the user's pose, then the walk, then the first one; "" for a rig with no clips at all. */
export function startClipName(names: Iterable<string>): string {
  const list = [...names];
  if (list.includes("user_pose")) return "user_pose";
  if (list.includes("walk_in_place")) return "walk_in_place";
  return list[0] ?? "";
}

/** The clip to show after `removed` is deleted from `names` (the library before the delete): the next one, else "" (no clips left). */
export function clipAfterDelete(names: readonly string[], removed: string): string {
  const rest = names.filter((n) => n !== removed);
  if (!rest.length) return "";
  const i = names.indexOf(removed);
  return rest[Math.min(Math.max(i, 0), rest.length - 1)] ?? "";
}
