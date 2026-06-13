/**
 * @file binding-migration.ts
 * @description Startup migration: under force-auto (auto-approve + ack), reset
 *   any channel binding stranded in `ask` mode back to `code` so the user is
 *   never gated behind a per-tool prompt. Targeted to the force-auto condition
 *   (not a blind rewrite of every binding) and run once at startup, so there is
 *   no live hand-editing of persisted state.
 * @status New (fix/bridge-auto-slash-callbacks).
 * @issues none known.
 * @todo none.
 */

/** Minimal store surface needed for the migration (satisfied by JsonFileStore). */
export interface BindingMigrationStore {
  listChannelBindings(): Array<{ id: string; mode: 'code' | 'plan' | 'ask' }>;
  updateChannelBinding(id: string, updates: { mode: 'code' }): void;
}

/** Force-auto flags needed to decide whether to migrate. */
export interface ForceAutoConfig {
  autoApprove?: boolean;
  autoApproveAck?: boolean;
}

/**
 * Reset stranded `ask` bindings to `code` when force-auto is active.
 * Returns the number of bindings migrated (0 when force-auto is off).
 */
export function migrateStrandedBindings(
  store: BindingMigrationStore,
  config: ForceAutoConfig,
): number {
  if (!(config.autoApprove && config.autoApproveAck)) return 0;
  const stranded = store.listChannelBindings().filter((b) => b.mode === 'ask');
  for (const b of stranded) {
    store.updateChannelBinding(b.id, { mode: 'code' });
  }
  return stranded.length;
}
