#!/usr/bin/env node
/**
 * Migrate `caster_notes` → `notes`, consolidating on the single notes system.
 *
 * WHY: two parallel notes stores exist. The old frontend writes `caster_notes`
 * directly via Supabase REST; the API (and /api/sync) serves `notes`. Only
 * `notes` has `updated_at` + `is_deleted`, which live edit/delete and
 * offline LWW sync both require.
 *
 * SAFETY
 *   - Dry run by default. Writes only with --apply.
 *   - Idempotent: skips rows whose id already exists in `notes`, so re-running
 *     after a partial failure cannot duplicate.
 *   - Never deletes or mutates `caster_notes`. Rollback is deleting the
 *     inserted ids from `notes`; the source table is untouched.
 *   - Preserves original `id` and `created_at`, so the two tables stay
 *     reconcilable and ordering is unchanged.
 *
 * USAGE
 *   node scripts/migrate-caster-notes.mjs           # dry run, prints a plan
 *   node scripts/migrate-caster-notes.mjs --verbose # + per-row mapping
 *   node scripts/migrate-caster-notes.mjs --apply   # actually insert
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
	console.error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.');
	process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

/**
 * Map one caster_notes row onto the notes schema.
 *
 * Field notes:
 *  - `author` is a display name ("Super G", "SYSTEM"). `notes` has only
 *    author_user_id / author_device_id, neither of which is a name. It is
 *    preserved in `author_name`, which requires the column to exist — see
 *    the ALTER printed by this script when it is missing.
 *  - `type` ('system' | 'manual') maps to `category`. That keeps
 *    machine-generated notes (AUTO_START etc.) distinguishable from user ones,
 *    which the merged Notes tab needs in order to render them differently.
 *  - `updated_at` seeds from `created_at`: these rows have never been edited,
 *    and LWW needs a non-null value to compare against.
 */
function mapRow(r) {
	return {
		id: r.id,
		content: r.content,
		event_key: r.event_key ?? null,
		match_key: r.match_key ?? null,
		team_key: r.team_key ?? null,
		category: r.type ?? null,
		author_name: r.author ?? null,
		author_device_id: null,
		author_user_id: null,
		is_deleted: false,
		created_at: r.created_at,
		updated_at: r.created_at
	};
}

async function main() {
	console.log(APPLY ? '=== APPLY (will write) ===' : '=== DRY RUN (no writes) ===');

	const { data: source, error: srcErr } = await sb
		.from('caster_notes')
		.select('*')
		.order('created_at', { ascending: true });
	if (srcErr) throw new Error(`read caster_notes: ${srcErr.message}`);

	const { data: existing, error: dstErr } = await sb.from('notes').select('id');
	if (dstErr) throw new Error(`read notes: ${dstErr.message}`);
	const already = new Set((existing ?? []).map((r) => r.id));

	const todo = source.filter((r) => !already.has(r.id));
	const skipped = source.length - todo.length;

	// Verify author_name exists before promising to preserve attribution.
	const { error: colErr } = await sb.from('notes').select('author_name').limit(1);
	const hasAuthorName = !colErr;

	console.log(`  source rows        : ${source.length}`);
	console.log(`  already in notes   : ${skipped}`);
	console.log(`  to migrate         : ${todo.length}`);
	console.log(`  author_name column : ${hasAuthorName ? 'present' : 'MISSING'}`);

	if (!hasAuthorName) {
		const names = [...new Set(source.map((r) => r.author).filter(Boolean))];
		console.log('');
		console.log(`  ${names.length} distinct author names would be LOST: ${names.join(', ')}`);
		console.log('  Run this first to preserve them:');
		console.log('');
		console.log('    alter table public.notes add column if not exists author_name text;');
		console.log('');
		if (APPLY) {
			console.error('  Refusing to apply and silently drop attribution. Add the column, then re-run.');
			process.exit(1);
		}
	}

	const bound = {
		matchAndTeam: todo.filter((r) => r.match_key && r.team_key).length,
		matchOnly: todo.filter((r) => r.match_key && !r.team_key).length,
		teamOnly: todo.filter((r) => !r.match_key && r.team_key).length,
		eventOnly: todo.filter((r) => !r.match_key && !r.team_key).length
	};
	console.log('');
	console.log(`  bindings — match+team ${bound.matchAndTeam}, match ${bound.matchOnly}, team ${bound.teamOnly}, event-only ${bound.eventOnly}`);
	console.log(`  categories — ${[...new Set(todo.map((r) => r.type))].join(', ')}`);

	if (VERBOSE) {
		console.log('\n  --- per-row mapping (first 5) ---');
		for (const r of todo.slice(0, 5)) {
			console.log('   ', JSON.stringify(mapRow(r)));
		}
	}

	if (!APPLY) {
		console.log('\n  Dry run complete. Nothing was written. Re-run with --apply to migrate.');
		return;
	}
	if (!todo.length) {
		console.log('\n  Nothing to do.');
		return;
	}

	// Insert in chunks so one oversized request cannot fail the whole batch.
	const CHUNK = 50;
	let inserted = 0;
	for (let i = 0; i < todo.length; i += CHUNK) {
		const batch = todo.slice(i, i + CHUNK).map(mapRow);
		const { error } = await sb.from('notes').insert(batch);
		if (error) {
			console.error(`\n  FAILED at row ${i}: ${error.message}`);
			console.error(`  ${inserted} rows were inserted. Re-running skips them (idempotent).`);
			process.exit(1);
		}
		inserted += batch.length;
		console.log(`  inserted ${inserted}/${todo.length}`);
	}

	console.log(`\n  Done. ${inserted} notes migrated. caster_notes is untouched.`);
	console.log('  Rollback: delete from notes where id in (select id from caster_notes);');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
