// Pruebas del ranking de la comunidad y del análisis de noticias (funciones puras, sin red). Uso: node test/ranking.mjs
import assert from 'node:assert/strict';
import { wilsonLB, tierOf, weightOf, config } from '../lib/ranking.js';
import { analyzeLocal, findDuplicate, originales } from '../lib/analysis.js';

let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);
const cfg = config(), mcp = { source: 'mcp', status: 'approved' }, v = (up, down) => ({ up, down });

assert.equal(wilsonLB(0, 0), 0); assert.ok(wilsonLB(3, 0) < wilsonLB(90, 10), '3 de 3 no le gana a 90 de 100'); assert.ok(wilsonLB(12, 0) > 0.7); assert.ok(wilsonLB(5, 5) < 0.5); ok('Wilson: pocos votos no inflan el puntaje');
assert.equal(tierOf(mcp, undefined, cfg), 'probation'); assert.equal(tierOf(mcp, v(11, 0), cfg), 'probation'); assert.equal(tierOf(mcp, v(12, 0), cfg), 'featured'); ok('una noticia nueva entra a prueba y sube con 12 votos buenos');
assert.equal(tierOf(mcp, v(7, 5), cfg), 'probation'); assert.equal(tierOf(mcp, v(4, 6), cfg), 'probation'); ok('tibias (mitad y mitad) se quedan a prueba');
assert.equal(tierOf(mcp, v(3, 7), cfg), 'retired'); assert.equal(tierOf(mcp, v(2, 8), cfg), 'retired'); assert.equal(tierOf(mcp, v(1, 8), cfg), 'probation', 'con 9 votos todavía no se retira'); ok('se retira con 10+ votos y menos de 35% de 👍');
assert.equal(tierOf({ source: 'colab', status: 'approved' }, v(0, 50), cfg), 'featured'); assert.equal(tierOf({ source: 'trend', status: 'approved' }, undefined, cfg), 'featured'); assert.equal(tierOf({ source: 'mcp', status: 'pinned' }, v(0, 50), cfg), 'featured'); ok('colaboraciones, tendencias y fijadas son siempre destacadas');
assert.equal(weightOf('probation', v(0, 0)), 1.5); assert.equal(weightOf('probation', v(8, 8)), 1);
assert.ok(weightOf('featured', v(40, 5)) > weightOf('featured', v(12, 1)) && weightOf('featured', v(12, 1)) > weightOf('featured', v(12, 4)));
for (const w of [weightOf('featured', v(500, 0)), weightOf('featured', v(1, 1))]) assert.ok(w >= 0.5 && w <= 3); ok('el peso de exposición crece con el puntaje y queda entre 0,5 y 3');

const buena = { titular: 'VECINO DESCUBRE QUE SU PARAGUAS ES UN BASTÓN', bajada: 'Lleva dos años abriéndolo bajo techo. Nadie le avisó.', movil: 'Desde un pasillo de Almagro', conductor: 'Atención, atención. Un vecino descubrió que su paraguas de toda la vida jamás fue paraguas. Dos años abriéndolo en pasillos y ascensores sin que nadie le avisara. Los especialistas piden calma y un poco de lluvia para confirmarlo.', ticker: ['El bastón no dio declaraciones', 'Se estudia pedir un paraguas nuevo'], emoji: ['☂️', '🧐'] };
const floja = { titular: 'COSA RARA EN LA CALLE', bajada: 'Pasó algo.', movil: 'En la calle', conductor: 'ALGO PASÓ Y TODOS SE ENTERARON DE UN MOMENTO A OTRO SIN QUE NADIE LO PIDIERA NUNCA', ticker: [], emoji: ['📺'] };
const a = analyzeLocal(buena), b = analyzeLocal(floja);
assert.ok(a.puntaje >= 80 && b.puntaje <= 40 && a.puntaje > b.puntaje); assert.ok(a.señales.length >= 5 && b.señales.some((s) => /mayúsculas/.test(s))); ok(`análisis por señales: buena ${a.puntaje}/100, floja ${b.puntaje}/100`);
const seed = originales()[0];
assert.equal(findDuplicate({ titular: seed.titular, bajada: seed.bajada }, originales()), seed.titular);
assert.equal(findDuplicate({ titular: seed.titular.toLowerCase(), bajada: 'Otra bajada distinta pero el mismo titular de siempre' }, originales()), seed.titular);
assert.equal(findDuplicate(buena, originales()), null); ok('detecta duplicadas contra las originales (aun con otra bajada) y deja pasar las nuevas');
console.log(`\n${n} verificaciones ok`);
