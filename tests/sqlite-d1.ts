import { DatabaseSync, type StatementSync } from "node:sqlite";

export class SQLiteD1Database {
  readonly native = new DatabaseSync(":memory:");
  readonly binding: D1Database;
  beforeNextBatch: (() => void) | undefined;
  beforeNextFirst: ((query: string) => void) | undefined;
  private batchTail: Promise<void> = Promise.resolve();

  constructor(schema: string) {
    this.native.exec("PRAGMA foreign_keys = ON");
    this.native.exec(schema);
    this.binding = {
      prepare: (query: string) =>
        new SQLiteD1Statement(this, this.native.prepare(query), query).binding,
      batch: (statements: D1PreparedStatement[]) => {
        const run = this.batchTail.then(async () => {
          const beforeBatch = this.beforeNextBatch;
          this.beforeNextBatch = undefined;
          beforeBatch?.();
          this.native.exec("BEGIN IMMEDIATE");
          try {
            const results: D1Result[] = [];
            for (const statement of statements)
              results.push(await statement.run());
            this.native.exec("COMMIT");
            return results;
          } catch (error) {
            this.native.exec("ROLLBACK");
            throw error;
          }
        });
        this.batchTail = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    } as unknown as D1Database;
  }

  rows(query: string): Record<string, unknown>[] {
    return (this.native.prepare(query).all() as Record<string, unknown>[]).map(
      (row) => ({ ...row }),
    );
  }
}

class SQLiteD1Statement {
  readonly binding: D1PreparedStatement;
  private arguments: SQLiteValue[] = [];

  constructor(
    private readonly database: SQLiteD1Database,
    private readonly native: StatementSync,
    private readonly query = "",
  ) {
    this.binding = {
      bind: (...values: unknown[]) => {
        this.arguments = values as SQLiteValue[];
        return this.binding;
      },
      run: async () => {
        try {
          const result = this.native.run(...this.arguments);
          return {
            success: true,
            results: [],
            meta: { changes: Number(result.changes) },
          } as unknown as D1Result;
        } catch (error) {
          if (error instanceof Error) {
            error.message = `${error.message}\nSQL: ${this.query}`;
          }
          throw error;
        }
      },
      first: async <T>() => {
        const beforeFirst = this.database.beforeNextFirst;
        this.database.beforeNextFirst = undefined;
        beforeFirst?.(this.query);
        return (this.native.get(...this.arguments) as T | undefined) ?? null;
      },
      all: async <T>() =>
        ({
          success: true,
          results: this.native.all(...this.arguments) as T[],
          meta: { changes: 0 },
        }) as unknown as D1Result<T>,
      raw: async (options?: { columnNames?: boolean }) => {
        const beforeFirst = this.database.beforeNextFirst;
        this.database.beforeNextFirst = undefined;
        beforeFirst?.(this.query);
        const columns = (
          this.native as StatementSync & {
            columns(): Array<{ name: string }>;
          }
        )
          .columns()
          .map((column: { name: string }) => column.name);
        const rows = (
          this.native.all(...this.arguments) as Record<string, unknown>[]
        ).map((row) => columns.map((column) => row[column]));
        return options?.columnNames ? [columns, ...rows] : rows;
      },
    } as unknown as D1PreparedStatement;
  }
}

type SQLiteValue = null | number | bigint | string | Uint8Array;
