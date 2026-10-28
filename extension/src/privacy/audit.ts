/**
 * Development/debug audit trail.
 *
 * Records WHAT was detected, WHAT was redacted, and WHAT TOKEN was
 * generated — but the raw value is a structurally separate type
 * (`AuditEntry` has no field capable of holding it) so it is impossible to
 * accidentally log a secret through this module.
 */
import type { SemanticType } from "../shared/types";

export interface AuditEntry {
  timestamp: number;
  elementId: string;
  semanticType: SemanticType;
  token: string | null;
  confidence: number;
  matchedBy: string[];
  action: "detected" | "redacted" | "tokenized" | "sent_to_backend" | "resolved_locally";
}

class AuditLog {
  private entries: AuditEntry[] = [];
  private debugMode = false;

  setDebugMode(on: boolean): void {
    this.debugMode = on;
  }

  record(entry: Omit<AuditEntry, "timestamp">): void {
    const full: AuditEntry = { ...entry, timestamp: Date.now() };
    this.entries.push(full);
    if (this.debugMode) {
      // eslint-disable-next-line no-console
      console.debug("[privacy-audit]", full);
    }
  }

  getEntries(): readonly AuditEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
  }

  summary(): { totalDetections: number; totalRedactions: number; byType: Record<string, number> } {
    const byType: Record<string, number> = {};
    let totalRedactions = 0;
    for (const e of this.entries) {
      if (e.action === "redacted") totalRedactions++;
      byType[e.semanticType] = (byType[e.semanticType] ?? 0) + 1;
    }
    return { totalDetections: this.entries.length, totalRedactions, byType };
  }
}

export const auditLog = new AuditLog();
