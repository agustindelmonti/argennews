// Ranking de las noticias de la comunidad (las que llegan por MCP). Nada llega al canal principal por mandarlo: se gana con votos.
//   a prueba (probation)  recién admitida: solo en el canal 5 (Comunidad), con un empujón de exposición para juntar votos
//   destacada (featured)  gustó: sube al canal 3 y se intercala entre las originales (1 cada N); cuanto mejor puntaje, más aparece
//   retirada (retired)    no gustó: sale de la programación sola (sigue en la base, la ves en el admin)
// Las colaboraciones y las tendencias ya pasaron por tu aprobación manual: siempre son destacadas. «pinned» = destacada a mano.
// Es una función pura de los votos: sin estados ocultos que se desincronicen.
const num = (k, d) => { const v = process.env[k]; const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) ? n : d; };

export const config = () => ({
  promoteMinVotes: num('PROMOTE_MIN_VOTES', 12),   // votos mínimos para subir al canal 3
  promoteMinLb: num('PROMOTE_MIN_LB', 0.5),        // y puntaje mínimo (límite inferior de Wilson, 95%)
  retireMinVotes: num('RETIRE_MIN_VOTES', 10),     // votos mínimos para poder retirarla
  retireMaxRatio: num('RETIRE_MAX_RATIO', 0.35),   // se retira si tiene menos de este % de 👍
  interleave: Math.max(1, Math.round(num('INTERLEAVE', 3))),   // en el canal 3: 1 de la comunidad cada N originales
});

// Límite inferior del intervalo de Wilson: ordena bien aunque haya pocos votos (3 de 3 no le gana a 90 de 100).
export function wilsonLB(up, down, z = 1.96) {
  const n = up + down; if (!n) return 0;
  const p = up / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

export function tierOf(seg, v, cfg = config()) {
  const up = v?.up || 0, down = v?.down || 0, n = up + down;
  if (seg.status === 'pinned' || seg.source !== 'mcp') return 'featured';
  if (n >= cfg.retireMinVotes && up / n < cfg.retireMaxRatio) return 'retired';
  if (n >= cfg.promoteMinVotes && wilsonLB(up, down) >= cfg.promoteMinLb) return 'featured';
  return 'probation';
}

// Exposición relativa dentro de su canal (más peso = sale más seguido).
export function weightOf(tier, v) {
  const up = v?.up || 0, down = v?.down || 0;
  if (tier === 'probation') return up + down < 10 ? 1.5 : 1;                       // las nuevas necesitan que las vean para poder ser votadas
  return Math.min(3, Math.max(0.5, 0.5 + wilsonLB(up, down) * 3));                  // destacadas: mejor puntaje, más aire (0,5 a 3)
}

export function summarize(seg, v, cfg = config()) {
  const up = v?.up || 0, down = v?.down || 0, tier = tierOf(seg, v, cfg);
  return { tier, up, down, lb: +wilsonLB(up, down).toFixed(3), peso: +weightOf(tier, v).toFixed(2) };
}
