// Minimal better-sqlite3 API over sql.js so the server engine runs unchanged in the browser.
type SqlDb = any;
let SQL: any = null;
export function setSqlJs(mod: any) {
  SQL = mod;
}

class Statement {
  constructor(private db: SqlDb, private sql: string, private owner: Database) {}
  private bind(params: any[]) {
    const stmt = this.db.prepare(this.sql);
    if (params.length) stmt.bind(params.map((p) => (typeof p === "boolean" ? Number(p) : p === undefined ? null : p)));
    return stmt;
  }
  get(...params: any[]) {
    const s = this.bind(params);
    try {
      return s.step() ? s.getAsObject() : undefined;
    } finally {
      s.free();
    }
  }
  all(...params: any[]) {
    const s = this.bind(params);
    const out: any[] = [];
    try {
      while (s.step()) out.push(s.getAsObject());
    } finally {
      s.free();
    }
    return out;
  }
  run(...params: any[]) {
    const s = this.bind(params);
    try {
      s.step();
    } finally {
      s.free();
    }
    const changes = this.db.getRowsModified();
    const r = this.db.exec("SELECT last_insert_rowid() AS id");
    const id = r[0]?.values[0]?.[0] ?? 0;
    this.owner.lastId = Number(id);
    return { changes, lastInsertRowid: Number(id) };
  }
}

export default class Database {
  db: SqlDb;
  lastId = 0;
  private depth = 0;
  constructor(_file?: string) {
    if (!SQL) throw new Error("sql.js not initialised");
    this.db = new SQL.Database();
  }
  exec(sql: string) {
    this.db.exec(sql);
  }
  prepare(sql: string) {
    return new Statement(this.db, sql, this);
  }
  transaction<T extends (...a: any[]) => any>(fn: T) {
    return ((...args: any[]) => {
      const name = `sp${this.depth++}`;
      this.db.exec(`SAVEPOINT ${name}`);
      try {
        const r = fn(...args);
        this.db.exec(`RELEASE ${name}`);
        return r;
      } catch (e) {
        this.db.exec(`ROLLBACK TO ${name}`);
        this.db.exec(`RELEASE ${name}`);
        throw e;
      } finally {
        this.depth--;
      }
    }) as unknown as T;
  }
  close() {
    this.db.close();
  }
}
