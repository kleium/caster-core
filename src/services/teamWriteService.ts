/**
 * TIMS-overrides + notes write endpoints — port of the write portion of
 * backend/app/routers/teams.py.
 */
import { getSupabase } from './supabase.js';
import { ApiError } from '../plugins/errorEnvelope.js';

type Obj = Record<string, unknown>;

const OV_FIELDS = [
  'custom_nickname',
  'custom_sponsor_read',
  'custom_robot_name',
  'custom_motto',
  'custom_organization',
  'custom_location',
  'custom_top_sponsors',
  'custom_pronunciation',
  'custom_hardware',
  'custom_auto_strategy',
  'custom_teleop_strategy',
  'custom_number_display',
] as const;

export interface TimsOverrideBody {
  custom_nickname?: string | null;
  custom_sponsor_read?: string | null;
  custom_robot_name?: string | null;
  custom_motto?: string | null;
  custom_organization?: string | null;
  custom_location?: string | null;
  custom_top_sponsors?: string | null;
  custom_pronunciation?: string | null;
  custom_hardware?: string | null;
  custom_auto_strategy?: string | null;
  custom_teleop_strategy?: string | null;
  custom_number_display?: string | null;
  author_device_id: string;
  author_name?: string | null;
  author_event_key?: string | null;
}

/** GET /{team_key}/tims-overrides — teams.py:97. */
export async function getTimsOverrides(teamKey: string): Promise<Obj> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('tims_overrides')
    .select('*')
    .eq('team_key', teamKey)
    .eq('is_deleted', false)
    .limit(1);
  if (error) throw new Error(error.message);
  return data && data.length ? data[0]! : {};
}

/**
 * PUT /{team_key}/tims-overrides — merge only explicitly-sent fields; fields
 * not present in the request body are left untouched. teams.py:117.
 */
export async function upsertTimsOverrides(teamKey: string, body: TimsOverrideBody): Promise<Obj> {
  const sb = getSupabase();

  const { data: existing, error: existErr } = await sb
    .from('tims_overrides')
    .select('*')
    .eq('team_key', teamKey)
    .eq('is_deleted', false)
    .limit(1);
  if (existErr) throw new Error(existErr.message);

  // Which fields the caller explicitly sent (mirrors Pydantic's exclude_unset —
  // key presence, not truthiness, since explicit nulls clear a field).
  const sent = new Set(Object.keys(body).filter((k) => (OV_FIELDS as readonly string[]).includes(k)));

  let row: Obj;
  if (existing && existing.length) {
    const prev = existing[0]!;
    row = {
      id: prev.id,
      team_key: teamKey,
      author_device_id: body.author_device_id,
      is_deleted: false,
    };
    for (const field of OV_FIELDS) {
      row[field] = sent.has(field) ? (body as unknown as Obj)[field] : prev[field];
    }
  } else {
    row = {
      team_key: teamKey,
      author_device_id: body.author_device_id,
      is_deleted: false,
    };
    for (const field of OV_FIELDS) {
      if (sent.has(field)) row[field] = (body as unknown as Obj)[field];
    }
  }

  if (body.author_name) row.author_name = body.author_name;
  if (body.author_event_key) row.author_event_key = body.author_event_key;

  const { data: saved, error } = await sb.from('tims_overrides').upsert(row).select();
  if (error) throw new Error(error.message);
  const result = saved && saved.length ? saved[0]! : row;

  // History log — non-fatal on failure.
  const snapshot: Obj = {};
  for (const f of OV_FIELDS) {
    if (row[f] !== null && row[f] !== undefined) snapshot[f] = row[f];
  }
  try {
    await sb.from('tims_overrides_history').insert({
      team_key: teamKey,
      author_name: body.author_name || 'Unknown',
      author_event_key: body.author_event_key ?? null,
      snapshot,
    });
  } catch {
    /* non-fatal: don't block the save */
  }

  return result;
}

/** GET /{team_key}/tims-overrides/history — teams.py:196. */
export async function getTimsOverridesHistory(teamKey: string): Promise<Obj[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('tims_overrides_history')
    .select('id, author_name, author_event_key, snapshot, created_at')
    .eq('team_key', teamKey)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** DELETE /{team_key}/tims-overrides — soft-delete. teams.py:214. */
export async function resetTimsOverrides(teamKey: string): Promise<Obj> {
  const sb = getSupabase();
  const { error } = await sb
    .from('tims_overrides')
    .update({ is_deleted: true })
    .eq('team_key', teamKey)
    .eq('is_deleted', false);
  if (error) throw new Error(error.message);
  return { status: 'reset', team_key: teamKey };
}

// ── Notes ────────────────────────────────────────────────────

export interface NoteCreateBody {
  content: string;
  team_key?: string | null;
  match_key?: string | null;
  event_key?: string | null;
  category?: string | null;
  author_device_id: string;
}

export interface NoteUpdateBody {
  content?: string | null;
  team_key?: string | null;
  match_key?: string | null;
  event_key?: string | null;
  category?: string | null;
}

/** GET /{team_key}/notes — teams.py:235. */
export async function getTeamNotes(
  teamKey: string,
  eventKey: string | undefined,
  sort: 'asc' | 'desc',
): Promise<Obj[]> {
  const sb = getSupabase();
  let q = sb
    .from('notes')
    .select('*')
    .eq('team_key', teamKey)
    .eq('is_deleted', false)
    .order('created_at', { ascending: sort === 'asc' });
  if (eventKey) q = q.eq('event_key', eventKey);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** POST /notes — teams.py:264. */
export async function createNote(body: NoteCreateBody): Promise<Obj> {
  if (!body.content || !body.content.trim()) {
    throw new ApiError(400, 'Note content cannot be empty.');
  }
  const sb = getSupabase();
  const row = {
    content: body.content.trim(),
    team_key: body.team_key ?? null,
    match_key: body.match_key ?? null,
    event_key: body.event_key ?? null,
    category: body.category ?? null,
    author_device_id: body.author_device_id,
    is_deleted: false,
  };
  const { data, error } = await sb.from('notes').insert(row).select();
  if (error) throw new Error(error.message);
  return data![0]!;
}

/** PUT /notes/{note_id} — teams.py:286. */
export async function updateNote(noteId: string, body: NoteUpdateBody): Promise<Obj> {
  const updates: Obj = {};
  for (const [k, v] of Object.entries(body)) {
    if (v !== null && v !== undefined) updates[k] = v;
  }
  if (Object.keys(updates).length === 0) {
    throw new ApiError(400, 'Nothing to update.');
  }
  const sb = getSupabase();
  const { data, error } = await sb
    .from('notes')
    .update(updates)
    .eq('id', noteId)
    .eq('is_deleted', false)
    .select();
  if (error) throw new Error(error.message);
  if (!data || !data.length) {
    throw new ApiError(404, 'Note not found.');
  }
  return data[0]!;
}

/** DELETE /notes/{note_id} — teams.py:310. */
export async function deleteNote(noteId: string): Promise<Obj> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('notes')
    .update({ is_deleted: true })
    .eq('id', noteId)
    .eq('is_deleted', false)
    .select();
  if (error) throw new Error(error.message);
  if (!data || !data.length) {
    throw new ApiError(404, 'Note not found.');
  }
  return { status: 'deleted', id: noteId };
}
