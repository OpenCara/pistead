/**
 * Sessions in list order with the ones another session's agent started (`parentSessionId`) right after their parent,
 * one level in, as the sidebar and the Sessions screen nest them. A session whose parent isn't in the list stays where
 * it is, at the top level; deeper descendants follow their own parent, so a chain reads as one block.
 */
export function nestSessions<T extends { id: string; parentSessionId?: string }>(sessions: readonly T[]): { session: T; depth: number }[] {
  const present = new Set(sessions.map(session => session.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const session of sessions) {
    const parent = session.parentSessionId;
    if (parent && present.has(parent) && parent !== session.id) {
      const list = children.get(parent);
      if (list) list.push(session);
      else children.set(parent, [session]);
    } else roots.push(session);
  }
  const nested: { session: T; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (session: T, depth: number) => {
    // A cycle can't come from the control plane, which never re-parents a session; never loop on one anyway.
    if (seen.has(session.id)) return;
    seen.add(session.id);
    nested.push({ session, depth });
    for (const child of children.get(session.id) ?? []) visit(child, Math.min(depth + 1, 3));
  };
  for (const root of roots) visit(root, 0);
  // Sessions only reachable through a cycle are still listed.
  for (const session of sessions) if (!seen.has(session.id)) visit(session, 0);
  return nested;
}
