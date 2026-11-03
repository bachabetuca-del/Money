import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { MarketRoiBadges, type RoiView } from './explorer-roi';
import { roiSportLabel } from '@/lib/roi-display';
import type { ExplorerDirection, ExplorerOrder, ExplorerSportGroup, RankedExplorerGame } from '@/lib/explorer-roi-filter';
import './explorer-catalog.css';

const STATE_LABEL: Record<string, string> = { live: 'En vivo', upcoming: 'Próximo', finished: 'Finalizado', unknown: 'Sin estado' };
const percent = (value: number) => `${value > 0 ? '+' : ''}${value.toLocaleString('es-US', { maximumFractionDigits: 2 })}%`;

export function ExplorerRoiControls({ order, minRoi, onChange }: {
  order: ExplorerOrder; minRoi: string;
  onChange: (patch: { order?: ExplorerOrder; minRoi?: string }) => void;
}) {
  return <div className="ws-roi-controls">
    <label className="ws-type-filter">Ordenar partidos
      <select value={order} onChange={e => onChange({ order: e.target.value as ExplorerOrder })} data-testid="filter-explorer-order">
        <option value="time">Por deporte y hora</option>
        <option value="roi">Mayor ROI · todos los deportes</option>
      </select>
    </label>
    <label className="ws-type-filter">ROI bruto mínimo (%)
      <input type="number" step="any" inputMode="decimal" value={minRoi} placeholder="Sin mínimo"
        onChange={e => onChange({ minRoi: e.target.value })} data-testid="filter-explorer-min-roi" />
    </label>
    {minRoi !== '' && <button type="button" className="ws-roi-reset" onClick={() => onChange({ minRoi: '' })}>Quitar mínimo</button>}
  </div>;
}

type Props = {
  sports: ExplorerSportGroup[];
  rankedGames: RankedExplorerGame[];
  order: ExplorerOrder;
  showRoi: boolean;
  ticker: string;
  query: string;
  scope: 'active' | 'history';
  direction: ExplorerDirection;
  roiView: (ticker: string) => RoiView;
  onSelect: (ticker: string) => void;
};

function GameRow({ game, open, toggle, rank, ...props }: Omit<Props, 'sports' | 'rankedGames' | 'order' | 'query'> & {
  game: RankedExplorerGame; open: boolean; toggle: () => void; rank?: number;
}) {
  const best = game.bestRoi;
  return <div className={`ws-game ${rank !== undefined ? 'ws-ranked-game' : ''}`}>
    <button className="ws-row game" aria-expanded={open} onClick={toggle} data-testid={`button-game-${game.key}`}>
      <ChevronRight className={open ? 'open' : ''} size={13} />
      <span className="name">
        {rank !== undefined && <span className="ws-roi-sport">{best ? `${rank}. ` : ''}{roiSportLabel(game.sport)}</span>}
        {game.name}<small>{game.date}</small>
        {props.showRoi && <span className="ws-game-roi" data-testid={`game-roi-${game.key}`}>
          {best ? <>
            <span className={`mr-badge mr-${best.signal.level}`}>
              Mayor ROI bruto · {best.signal.side === 'yes' ? 'SÍ' : 'NO'} · {percent(best.signal.roiPct!)}
            </span>
            <span className="ws-roi-reference">{best.market.betLabel}</span>
          </> : <span className="mr-badge mr-insufficient">Sin ROI con muestra suficiente</span>}
        </span>}
        {props.scope === 'history' && <small className="ws-history-result">{game.markets.find(m => m.gameResult)?.gameResult ??
          game.markets.find(m => m.scoreMessage)?.scoreMessage ??
          (game.markets.every(m => m.scoreStatus === 'unavailable') ? 'Marcador no disponible' : 'Marcador pendiente de cargar')}</small>}
      </span><span className="count">{game.trades}</span>
    </button>
    {open && game.markets.map(m => (
      <button key={m.ticker} className={`ws-row market ${m.ticker === props.ticker ? 'sel' : ''}`}
        onClick={() => props.onSelect(m.ticker)} aria-current={m.ticker === props.ticker} data-testid={`button-market-${m.ticker}`}>
        <span className={`ws-state ${m.state}`}>{STATE_LABEL[m.state]}</span>
        <span className="name">{m.betLabel}<MarketRoiBadges view={props.roiView(m.ticker)} direction={props.direction} /></span>
        <span className="count">{m.trades}</span>
      </button>
    ))}
  </div>;
}

/** Retain the existing tree, with a global game list only when ROI order is chosen. */
export function ExplorerCatalog(props: Props) {
  const [openSports, setOpenSports] = useState(new Set<string>());
  const [openGames, setOpenGames] = useState(new Set<string>());
  const selectedSport = props.sports.find(s => s.games.some(g => g.markets.some(m => m.ticker === props.ticker)))?.sport;
  const toggle = (set: Set<string>, key: string, open: boolean) => {
    const next = new Set(set);
    if (open) { next.delete(key); next.add(`-${key}`); } else { next.add(key); next.delete(`-${key}`); }
    return next;
  };
  const gameRow = (game: RankedExplorerGame, rank?: number) => {
    const open = !!props.query.trim() || openGames.has(game.key) ||
      (game.markets.some(m => m.ticker === props.ticker) && !openGames.has(`-${game.key}`));
    return <GameRow key={`${game.sport}:${game.key}`} {...props} game={game} rank={rank} open={open}
      toggle={() => setOpenGames(toggle(openGames, game.key, open))} />;
  };
  if (props.order === 'roi') return <div className="ws-roi-list" data-testid="catalog-roi-order">
    {props.rankedGames.map((game, index) => gameRow(game, index + 1))}
  </div>;
  return <>{props.sports.map(s => {
    const open = !!props.query.trim() || openSports.has(s.sport) || (selectedSport === s.sport && !openSports.has(`-${s.sport}`));
    return <div key={s.sport} className="ws-sport">
      <button className="ws-row sport" aria-expanded={open} onClick={() => setOpenSports(toggle(openSports, s.sport, open))}
        data-testid={`button-sport-${s.sport}`}>
        <ChevronRight className={open ? 'open' : ''} size={14} />
        <span className="name">{s.sport}</span><span className="count">{s.trades.toLocaleString('en-US')}</span>
      </button>
      {open && s.games.map(game => gameRow(game))}
    </div>;
  })}</>;
}
