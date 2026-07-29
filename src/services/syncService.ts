/**
 * POST /api/sync — delta-sync for the Offline-First BFF. Port of
 * backend/app/routers/sync.py.
 *
 * Protocol: client sends event_key + last_sync (ISO 8601, omit/null for a
 * full sync) + pending_edits (local notes/tims_overrides to merge via LWW on
 * updated_at). Server returns server_time (captured BEFORE any reads, so no
 * row can slip between the read and the timestamp) + changes (table → rows
 * changed since last_sync, scoped to the event).
 */
import { getSupabase, fetchChanged } from './supabase.js';

type Obj = Record<string, unknown>;

export interface PendingEdit {
  table: 'notes' | 'tims_overrides';
  row: Obj;
}

export interface SyncRequest {
  event_key: string;
  last_sync?: string | null;
  pending_edits?: PendingEdit[];
}

export interface SyncResponse {
  server_time: string;
  changes: Record<string, Obj[]>;
}

const EPOCH = '1970-01-01T00:00:00+00:00';

/** Apply client-side edits using Last-Write-Wins on updated_at. sync.py:64. */
async function applyPendingEdits(edits: PendingEdit[]): Promise<void> {
  if (edits.length === 0) return;

  const sb = getSupabase();

  for (const edit of edits) {
    const { table } = edit;
    const row = { ...edit.row };

    const rowId = row.id;
    if (!rowId) {
      console.warn(`Rejecting edit with no id for table ${table}`);
      continue;
    }

    const clientTs = row.updated_at as string | undefined;
    if (!clientTs) {
      console.warn(`Rejecting edit with no updated_at for ${table}/${rowId}`);
      continue;
    }

    try {
      const { data, error } = await sb.from(table).select('updated_at').eq('id', rowId);
      if (error) throw new Error(error.message);
      if (data && data.length) {
        const serverTs = data[0]!.updated_at as string;
        // Compare as ISO strings (both UTC) — lexicographic ordering works.
        if (serverTs >= clientTs) {
          continue;
        }
      }
    } catch (e) {
      console.warn(`LWW check failed for ${table}/${rowId}: ${String(e)}`);
      // Fall through to upsert — if the row doesn't exist, this is an INSERT.
    }

    try {
      const { error } = await sb.from(table).upsert(row);
      if (error) throw new Error(error.message);
    } catch (e) {
      console.warn(`Edit upsert failed: ${table}/${rowId}: ${String(e)}`);
    }
  }
}

/** Fetch all rows changed since `since` for the given event scope. sync.py:114. */
async function fetchDelta(eventKey: string, since: string): Promise<Record<string, Obj[]>> {
  const changes: Record<string, Obj[]> = {};

  // 1) Event metadata
  const eventRows = await fetchChanged('events', since, { event_key: eventKey });
  if (eventRows.length) changes.events = eventRows;

  // 2) Matches scoped to this event
  const matchRows = await fetchChanged('matches', since, { event_key: eventKey });
  if (matchRows.length) changes.matches = matchRows;

  // 3) Event-teams junction scoped to this event
  const etRows = await fetchChanged('event_teams', since, { event_key: eventKey });
  if (etRows.length) changes.event_teams = etRows;

  // 4) Teams: all teams whose team_key appears in event_teams for this event
  //    (the junction scopes which team rows are relevant).
  let teamKeys: Set<string>;
  if (etRows.length) {
    teamKeys = new Set(etRows.map((r) => r.team_key as string));
  } else {
    const sb = getSupabase();
    const { data } = await sb.from('event_teams').select('team_key').eq('event_key', eventKey);
    teamKeys = new Set((data ?? []).map((r) => r.team_key as string));
  }

  if (teamKeys.size) {
    const teamRows = await fetchChanged('teams', since);
    const scopedTeams = teamRows.filter((r) => teamKeys.has(r.team_key as string));
    if (scopedTeams.length) changes.teams = scopedTeams;
  }

  // 5) Notes — relevant if event_key matches, match_key belongs to this event,
  //    team_key is one of the teams at this event, or (legacy) target_key matches.
  const allNotes = await fetchChanged('notes', since);
  if (allNotes.length) {
    const relevantNotes = allNotes.filter((n) => {
      const nEk = (n.event_key as string) || '';
      const nMk = (n.match_key as string) || '';
      const nTk = (n.team_key as string) || '';
      const nLegacy = (n.target_key as string) || '';
      return (
        nEk === eventKey ||
        nMk.startsWith(`${eventKey}_`) ||
        teamKeys.has(nTk) ||
        nLegacy === eventKey ||
        nLegacy.startsWith(`${eventKey}_`) ||
        teamKeys.has(nLegacy)
      );
    });
    if (relevantNotes.length) changes.notes = relevantNotes;
  }

  // 6) tims_overrides — scoped by team_key at this event
  const allOverrides = await fetchChanged('tims_overrides', since);
  if (allOverrides.length) {
    const relevant = allOverrides.filter((r) => teamKeys.has(r.team_key as string));
    if (relevant.length) changes.tims_overrides = relevant;
  }

  return changes;
}

/**
 * Delta-sync handler. 1) capture server_time before any reads, 2) apply
 * pending edits (LWW), 3) fetch the delta since last_sync. sync.py:194.
 */
export async function runSync(req: SyncRequest): Promise<SyncResponse> {
  // 1) Capture server_time BEFORE reads.
  const serverTime = new Date().toISOString();

  // 2) Apply pending edits.
  if (req.pending_edits?.length) {
    await applyPendingEdits(req.pending_edits);
  }

  // 3) Determine since cutoff + fetch delta.
  const since = req.last_sync || EPOCH;
  const changes = await fetchDelta(req.event_key, since);

  return { server_time: serverTime, changes };
}
