/** Read-only production reconciliation on 2026-11-17. Public executions only;
 * no chat/user/account identifiers. This is audit evidence, NOT trial data. */
export type AuditedSignal = {
  tradeId: string; eventTitle: string; side: string; price: number; notional: number;
  observed: string; saved: string; queued: string; decided: string; confirmed: string;
  games: number; trades: number; roi: number; fee: number; result: string | null;
};
export const AUDITED_SIGNALS: AuditedSignal[] = [
  {
    tradeId: "0726460f-a961-94e7-89ce-3ee3254a77dd", eventTitle: "Wales vs Portugal",
    side: "yes", price: .15, notional: 1462.5, observed: "2026-11-17T21:00:56.184Z",
    saved: "2026-11-17T21:17:09.556Z", queued: "2026-11-17T21:17:10.101Z",
    decided: "2026-11-17T21:30:02.844Z", confirmed: "2026-11-17T21:30:03.579Z",
    games: 100, trades: 379, roi: 61.42075827822088, fee: 5.95, result: "no",
  },
  {
    tradeId: "07264620-d6b9-9770-58eb-9aaeab919465", eventTitle: "Ball St. vs Ohio: Spread",
    side: "yes", price: .63, notional: 7662.06, observed: "2026-11-17T20:56:48.845Z",
    saved: "2026-11-17T21:11:30.616Z", queued: "2026-11-17T21:11:31.583Z",
    decided: "2026-11-17T21:24:18.549Z", confirmed: "2026-11-17T21:24:19.544Z",
    games: 79, trades: 166, roi: 18.422380641225836, fee: 2.59, result: null,
  },
  {
    tradeId: "0726466b-c0b1-a09f-b681-8ffc63066fe1", eventTitle: "Denmark vs Norway",
    side: "yes", price: .19, notional: 1489.1478, observed: "2026-11-17T20:53:11.012Z",
    saved: "2026-11-17T21:05:38.569Z", queued: "2026-11-17T21:05:39.325Z",
    decided: "2026-11-17T21:17:12.546Z", confirmed: "2026-11-17T21:17:13.545Z",
    games: 100, trades: 379, roi: 61.42075827822088, fee: 5.67, result: "yes",
  },
  {
    tradeId: "07264627-9301-bf58-082f-9bbb26599782", eventTitle: "Denmark vs Norway: Total Goals",
    side: "no", price: .39, notional: 2573.8206, observed: "2026-11-17T20:52:02.222Z",
    saved: "2026-11-17T21:04:20.055Z", queued: "2026-11-17T21:04:22.293Z",
    decided: "2026-11-17T21:15:24.299Z", confirmed: "2026-11-17T21:15:24.794Z",
    games: 89, trades: 170, roi: 16.60728576374267, fee: 4.27, result: "yes",
  },
  {
    tradeId: "07264627-b041-addc-8fd7-83bc4a6cfe16", eventTitle: "Denmark vs Norway: Total Goals",
    side: "no", price: .39, notional: 1000.8492, observed: "2026-11-17T20:52:00.712Z",
    saved: "2026-11-17T21:04:20.055Z", queued: "2026-11-17T21:04:20.819Z",
    decided: "2026-11-17T21:15:19.576Z", confirmed: "2026-11-17T21:15:20.794Z",
    games: 89, trades: 170, roi: 16.60728576374267, fee: 4.27, result: "yes",
  },
  {
    tradeId: "07264633-6f31-939c-b536-600e68a1a2bf", eventTitle: "Denmark vs Norway: Total Goals",
    side: "no", price: .38, notional: 1140, observed: "2026-11-17T20:46:28.900Z",
    saved: "2026-11-17T20:55:18.108Z", queued: "2026-11-17T20:55:18.587Z",
    decided: "2026-11-17T21:07:19.563Z", confirmed: "2026-11-17T21:07:20.823Z",
    games: 89, trades: 170, roi: 16.60728576374267, fee: 4.34, result: "yes",
  },
];
