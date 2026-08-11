import { sql, type SQLWrapper } from "drizzle-orm";

import { createDatabase } from "./client";

/**
 * Executes parameterized Drizzle SQL expressions through D1's transactional
 * batch primitive.
 *
 * Drizzle 0.45's D1 `db.batch()` cannot prepare a parameterized `db.run(sql)`
 * item because `SQLiteRaw` does not expose the bound D1 statement expected by
 * that adapter. Complex guarded INSERT...SELECT statements still need D1's
 * all-or-nothing batch behavior, so this is the single native preparation
 * boundary. Callers remain responsible for constructing SQL with Drizzle's
 * `sql` template and schema objects; raw strings are deliberately not accepted.
 */
export async function runDrizzleBatch(
  database: D1Database,
  queries: readonly [SQLWrapper, ...SQLWrapper[]],
): Promise<D1Result[]> {
  const db = createDatabase(database);
  const statements = queries.map((query) => {
    const built = db.run(query).getQuery();
    return database.prepare(built.sql).bind(...built.params);
  });
  return database.batch(statements);
}

/**
 * Adapts a static, numbered-placeholder SQL statement to Drizzle-bound SQL.
 * Keep this for complex CHECK-guarded state transitions whose exact SQL is the
 * reviewed atomicity contract; ordinary CRUD must use typed query builders.
 */
export function parameterizedSQL(
  query: string,
  values: readonly unknown[],
): SQLWrapper {
  return sql.join(
    query.split(/(\?[1-9]\d*)/g).map((part) => {
      const placeholder = /^\?([1-9]\d*)$/.exec(part);
      return placeholder
        ? sql`${values[Number(placeholder[1]) - 1]}`
        : sql.raw(part);
    }),
    sql.raw(""),
  );
}
