export interface AuditEventRecord {
  source: string;
  timestamp?: string;
  payload: Record<string, unknown>;
}

export interface AuditEventQuery {
  source?: string;
  cycleId?: string;
  q?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface IAuditReader {
  readRecent(limit?: number): Promise<AuditEventRecord[]>;
  queryEvents?(query?: AuditEventQuery): Promise<AuditEventRecord[]>;
  close?(): Promise<void>;
}
