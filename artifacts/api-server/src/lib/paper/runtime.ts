import { and, asc, eq, lte, sql } from "drizzle-orm";
import { db, kalshiPaperRunsTable as runs, kalshiNotificationsTable as notifications } from "@workspace/db";
import type { PaperRun } from "@workspace/api-zod";
import type { KalshiAuth } from "../kalshi-auth";
import type { NotificationObservation } from "../telegram-trade-notifications";
import { logger } from "../logger";
import { PaperBookStream } from "./book-stream";
import type { BookQuote } from "./book";
import { candidateEvidence } from "./evidence";
import { PAPER_MAX_QUEUE } from "./protocol";
import { recordCandidate, readCandidate, scheduleCandidate, pendingCandidateIds, toRun } from "./repository";
import { pendingExecutions, processPaperExecution, settlePaperBatch } from "./processor";
import { matchPaperControls } from "./controls";
import { refreshPaperReports } from "./report";

type Capture = { at: number; capturedAt?: Date; book?: BookQuote | null };
type Work = () => Promise<void>;
class PaperRuntime {
  private stream?: PaperBookStream;
  private run: PaperRun | null = null;
  private captures = new Map<string, Capture>();
  private traces = new Map<string, Record<string, string | number | null>>();
  private receipts = new Map<string, number>();
  private queue: Work[] = [];
  private lost = new Set<string>();
  private queueBusy = false;
  private pollBusy = false;
  private reportBusy = false;
  private ready = false;
  get canActivate() { return this.ready && process.env.NODE_ENV === "production" && process.env.BOT_WORKERS_ENABLED !== "false"; }
  start(auth: KalshiAuth) {
    if (this.ready || process.env.BOT_WORKERS_ENABLED === "false") return;
    this.stream = new PaperBookStream(auth); this.ready = true;
    // Call only after the production worker advisory lock has been acquired.
    setInterval(() => this.clock(), 100).unref();
    setInterval(() => void this.flush(), 250).unref();
    setInterval(() => void this.poll(), 1000).unref();
    setInterval(() => void this.maintenance(), 60000).unref();
    void this.poll();
  }
  received(tradeId: string, at = Date.now()) {
    if (!this.run) return;
    if (!this.receipts.has(tradeId)) this.receipts.set(tradeId, at);
    if (this.receipts.size > 2000) this.receipts.delete(this.receipts.keys().next().value!);
  }
  /** Entirely synchronous and bounded. Notification delivery never awaits this. */
  observe(event: NotificationObservation) {
    const run = this.run;
    if (!run || !this.stream || event.at.getTime() >= Date.parse(run.endsAt!) || this.lost.size) return;
    const id = event.job.tradeId;
    let trace = this.traces.get(id);
    if (!trace) {
      if (this.traces.size >= 1000) this.traces.delete(this.traces.keys().next().value!);
      trace = { receivedAt: this.receipts.has(id) ? new Date(this.receipts.get(id)!).toISOString() : null };
      this.traces.set(id, trace);
    }
    const previous = trace[event.stage];
    if (!previous || event.stage !== "dequeued") trace[event.stage] = event.at.toISOString();
    trace.attempts = event.job.attempts;
    if (event.telegramDate) trace.telegramServerDate = new Date(event.telegramDate * 1000).toISOString();
    if (event.retryAfterMs) trace.retryAfterMs = event.retryAfterMs;
    if (event.stage === "decision") {
      this.stream.watch(event.job.ticker, event.at.getTime() + 330000, run.protocol.maxMarkets);
      const evidence = candidateEvidence(run, event.job, event.roi ?? null, event.accepted ?? false,
        event.reason ?? "unverified", event.at, this.stream.quote(event.job.ticker, event.at.getTime()), trace);
      if (!evidence.accepted) this.prepareCaptures(run, id, event.job.ticker, event.at.getTime() + 1000);
      this.enqueue(id, async () => {
        const c = await recordCandidate(run, evidence);
        if (c && !c.eligible) await scheduleCandidate(run, c.id, null, { ...trace },
          this.captures.get(`${id}:0`)?.book ?? null);
      });
    }
    if (event.stage === "confirmed") {
      this.prepareCaptures(run, id, event.job.ticker, event.at.getTime());
      const timing = { ...trace }, deliveryBook = this.stream.quote(event.job.ticker, event.at.getTime());
      this.enqueue(id, async () => {
        const c = await readCandidate(run.id, id);
        if (c) await scheduleCandidate(run, c.id, event.at, timing, deliveryBook);
      });
    }
  }
  private prepareCaptures(run: PaperRun, tradeId: string, ticker: string, base: number) {
    const delays = [...new Set([0, 60, run.protocol.delaySeconds])];
    for (const d of delays) {
      const key = `${tradeId}:${d}`;
      if (this.captures.has(key)) continue;
      if (this.captures.size >= PAPER_MAX_QUEUE * 3) { this.lost.add(tradeId); break; }
      const at = base + d * 1000;
      const entry: Capture & { ticker?: string } = { at, ticker };
      if (d === 0 && base <= Date.now()) {
        entry.capturedAt = new Date(base);
        entry.book = this.stream?.quote(ticker, base) ?? null;
      }
      this.captures.set(key, entry);
    }
    this.stream?.watch(ticker, base + Math.max(...delays) * 1000 + 15000, run.protocol.maxMarkets);
  }
  private clock() {
    const now = Date.now();
    try {
      this.stream?.tick(now);
      for (const [key, c] of this.captures) {
        if (!c.capturedAt && c.at <= now) {
          c.capturedAt = new Date(now);
          c.book = this.stream?.quote((c as Capture & { ticker: string }).ticker, now) ?? null;
        }
        if (now - c.at > 360000) this.captures.delete(key);
      }
    } catch {
      // An observation failure never terminates live ingestion/Telegram.
      logger.warn("Paper orderbook observer failed; affected entries will remain unknown");
    }
  }
  private enqueue(tradeId: string, work: Work) {
    if (this.queue.length >= PAPER_MAX_QUEUE) { this.lost.add(tradeId); return; }
    this.queue.push(work);
  }
  private async flush() {
    if (this.queueBusy || !this.queue.length) return;
    this.queueBusy = true;
    try {
      for (let i = 0; i < 10 && this.queue.length; i++) {
        await this.queue[0](); this.queue.shift();
      }
    } catch {
      logger.warn("Paper evidence persistence will retry; Telegram is unaffected");
    } finally { this.queueBusy = false; }
  }
  private lastStateRead = 0;
  private maintenanceCursor = 0;
  private async poll() {
    if (this.pollBusy || !this.stream) return;
    this.pollBusy = true;
    try {
      const now = new Date();
      if (now.getTime() - this.lastStateRead > 3000) {
        await db.update(runs).set({ status: "finished" }).where(and(eq(runs.status, "active"), lte(runs.endsAt, now)));
        const [row] = await db.select().from(runs).where(eq(runs.status, "active")).limit(1);
        if ((row?.id ?? null) !== this.run?.id) {
          this.stream.setEnabled(false);
          this.run = row ? toRun(row) : null;
          this.stream.setEnabled(!!row);
        } else if (row) this.run = toRun(row);
        this.lastStateRead = now.getTime();
      }
      if (this.run && this.lost.size) {
        await db.update(runs).set({ status: "paused", pausedAt: now,
          dropped: sql`${runs.dropped} + ${this.lost.size}`,
          workerError: "La cola de investigación llegó a su límite. Se detuvo esta prueba sin interrumpir Telegram." })
          .where(eq(runs.id, this.run.id));
        this.lost.clear(); this.run = null; this.stream.setEnabled(false);
      }
      const due = await pendingExecutions(now);
      for (const { execution: x, candidate: c } of due) {
        if (x.dueAt > now) continue;
        const key = `${c.tradeId}:${x.delaySeconds}`;
        const capture = this.captures.get(key);
        // A restart/missed deadline cannot be repaired with today's book.
        if (!capture && now.getTime() - x.dueAt.getTime() <= 1500) {
          const book = this.stream.quote(c.ticker, now.getTime());
          this.captures.set(key, { at: x.dueAt.getTime(), capturedAt: now, book });
        }
        const frozen = this.captures.get(key);
        await processPaperExecution(x.id, frozen?.book ?? null, frozen?.capturedAt ?? now);
      }
      // No long-lived bot duplication: just a heartbeat for the existing owner.
      if (this.run && now.getSeconds() % 10 === 0)
        await db.update(runs).set({ heartbeatAt: now, workerError: this.stream.error }).where(eq(runs.id, this.run.id));
    } catch {
      logger.warn("Paper worker deferred an iteration; original alerts remain independent");
    } finally { this.pollBusy = false; }
  }
  private async maintenance() {
    if (this.reportBusy) return;
    this.reportBusy = true;
    try {
      // Recover only existing decisions. A read/migration never enrolls legacy notices.
      const activeRuns = await db.select().from(runs)
        .where(sql`${runs.status} IN ('active','paused','finished')`).orderBy(asc(runs.createdAt)).limit(100);
      const inactive = activeRuns.filter(r => r.status !== "active");
      const batch = [activeRuns.find(r => r.status === "active"),
        inactive.length ? inactive[this.maintenanceCursor++ % inactive.length] : undefined].filter(r => !!r);
      for (const raw of batch) {
        const run = toRun(raw);
        for (const c of await pendingCandidateIds(run.id)) {
          const [notice] = await db.select({ sentAt: notifications.sentAt, skippedAt: notifications.skippedAt })
            .from(notifications).where(eq(notifications.tradeId, c.tradeId)).limit(1);
          if (!c.eligible || notice?.sentAt) {
            await scheduleCandidate(run, c.id, notice?.sentAt ?? null,
              { recoveredFromStoredConfirmation: true, lostContemporaneousBook: true }, null);
          }
        }
        if (run.status === "active") await matchPaperControls(run);
        await settlePaperBatch(run.id);
      }
      await refreshPaperReports();
    } catch {
      logger.warn("Paper settlement/report work will retry independently");
    } finally { this.reportBusy = false; }
  }
}
export const paperRuntime = new PaperRuntime();
