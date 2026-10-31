const assert = require('node:assert/strict');
const layout = require('../server/layout.js');

const {gap, edgeMin, edgeMax} = layout.constants;
const card = (id, fixed = false, x = 0, y = 0) => ({id, width: 200, height: 140, fixed, x, y});
const hubCards = [card('center', true, 600, 400), ...Array.from({length: 39}, (_, i) => card('leaf-' + String(i).padStart(2, '0')))]
  .map(value => ({...value, fixed: value.id === 'center'}));
const hubEdges = hubCards.slice(1).map(value => ({from: 'center', to: value.id}));

function overlaps(a, b, positions, nodes) {
  const first = nodes.get(a), second = nodes.get(b), firstPoint = positions[a], secondPoint = positions[b];
  return firstPoint.x < secondPoint.x + second.width + gap && secondPoint.x < firstPoint.x + first.width + gap
    && firstPoint.y < secondPoint.y + second.height + gap && secondPoint.y < firstPoint.y + first.height + gap;
}

const clueCard = id => ({id, width: 200, height: 100, fixed: false, x: 0, y: 0});
function clueFixture(branchCount, cluesPerBranch) {
  const cards = [clueCard('c')], edges = [];
  for (let i = 0; i < branchCount; i++) {
    const branch = 'b' + i;
    cards.push(clueCard(branch));
    edges.push({from: 'c', to: branch});
    for (let j = 0; j < cluesPerBranch; j++) {
      const clue = branch + 'k' + j;
      cards.push(clueCard(clue));
      edges.push({from: branch, to: clue});
    }
  }
  const cross = branchCount === 5
    ? [['b0k0', 'b2k1'], ['b1k2', 'b3k0'], ['b4k1', 'b0k3'], ['b2k3', 'b4k2']]
    : [['b0k0', 'b2k1'], ['b1k2', 'b3k0'], ['b4k1', 'b0k3'], ['b2k3', 'b4k2'],
      ['b5k0', 'b1k4'], ['b3k4', 'b5k2']];
  for (const [from, to] of cross) edges.push({from, to});
  return {cards, edges, treeEdges: edges.slice(0, branchCount + branchCount * cluesPerBranch)};
}

function point(id, positions, nodes) {
  const node = nodes.get(id), position = positions[id];
  return {x: position.x + node.width / 2, y: position.y + node.height / 2};
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angleDelta(a, b) {
  let value = a - b;
  while (value <= -Math.PI) value += Math.PI * 2;
  while (value > Math.PI) value -= Math.PI * 2;
  return value;
}

function orientation(a, b, c) {
  const value = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return Math.abs(value) < 1e-7 ? 0 : value > 0 ? 1 : -1;
}

function crosses(a, b, c, d) {
  return orientation(a, b, c) * orientation(a, b, d) < 0
    && orientation(c, d, a) * orientation(c, d, b) < 0;
}

function clueMetrics(fixture, positions) {
  const nodes = new Map(fixture.cards.map(value => [value.id, value]));
  const root = point('c', positions, nodes);
  const bounds = fixture.cards.reduce((value, card) => {
    const position = positions[card.id];
    return {
      left: Math.min(value.left, position.x), top: Math.min(value.top, position.y),
      right: Math.max(value.right, position.x + card.width), bottom: Math.max(value.bottom, position.y + card.height),
    };
  }, {left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity});
  const componentCenter = {x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2};
  const boundingRadius = Math.max(...fixture.cards.map(card => distance(point(card.id, positions, nodes), componentCenter)));
  const branchIds = fixture.cards.filter(card => /^b\d+$/.test(card.id)).map(card => card.id);
  const branchDistances = branchIds.map(id => distance(point(id, positions, nodes), root));
  const meanBranchDistance = branchDistances.reduce((sum, value) => sum + value, 0) / branchDistances.length;
  const branchSpread = Math.max(...branchDistances.map(value => Math.abs(value - meanBranchDistance))) / meanBranchDistance;
  let clueOutsideBranch = 0, wedgeViolations = 0;
  for (const branch of branchIds) {
    const branchDistance = distance(point(branch, positions, nodes), root);
    const branchAngle = Math.atan2(point(branch, positions, nodes).y - root.y, point(branch, positions, nodes).x - root.x);
    for (const card of fixture.cards.filter(value => value.id.startsWith(branch + 'k'))) {
      const cluePoint = point(card.id, positions, nodes);
      if (distance(cluePoint, root) <= branchDistance) clueOutsideBranch++;
      const clueAngle = Math.atan2(cluePoint.y - root.y, cluePoint.x - root.x);
      if (Math.abs(angleDelta(clueAngle, branchAngle)) > Math.PI / branchIds.length + 0.08) wedgeViolations++;
    }
  }
  let treeCrossings = 0;
  for (let i = 0; i < fixture.treeEdges.length; i++) for (let j = i + 1; j < fixture.treeEdges.length; j++) {
    const first = fixture.treeEdges[i], second = fixture.treeEdges[j];
    if (new Set([first.from, first.to, second.from, second.to]).size < 4) continue;
    if (crosses(point(first.from, positions, nodes), point(first.to, positions, nodes),
      point(second.from, positions, nodes), point(second.to, positions, nodes))) treeCrossings++;
  }
  let overlapCount = 0;
  for (let i = 0; i < fixture.cards.length; i++) for (let j = i + 1; j < fixture.cards.length; j++) {
    if (overlaps(fixture.cards[i].id, fixture.cards[j].id, positions, nodes)) overlapCount++;
  }
  return {
    rootOffsetRatio: distance(root, componentCenter) / boundingRadius,
    branchSpread,
    clueOutsideBranch,
    wedgeViolations,
    treeCrossings,
    overlapCount,
  };
}

for (const [branchCount, cluesPerBranch] of [[5, 4], [6, 5]]) {
  const fixture = clueFixture(branchCount, cluesPerBranch);
  assert.equal(fixture.cards.length, 1 + branchCount + branchCount * cluesPerBranch);
  assert.equal(fixture.treeEdges.length, branchCount + branchCount * cluesPerBranch);
  assert.equal(fixture.edges.length, fixture.treeEdges.length + (branchCount === 5 ? 4 : 6));
  const first = layout(fixture.cards, fixture.edges), second = layout(fixture.cards, fixture.edges);
  assert.deepEqual(first, second);
  const metrics = clueMetrics(fixture, first);
  assert.ok(metrics.rootOffsetRatio <= 0.10, `root offset ${(metrics.rootOffsetRatio * 100).toFixed(2)}%`);
  assert.ok(metrics.branchSpread <= 0.15, `branch spread ${(metrics.branchSpread * 100).toFixed(2)}%`);
  assert.equal(metrics.clueOutsideBranch, 0, 'a clue is not outside its branch ring');
  assert.equal(metrics.wedgeViolations, 0, 'a clue left its branch wedge');
  assert.equal(metrics.treeCrossings, 0, 'tree edges cross');
  assert.equal(metrics.overlapCount, 0, 'cards overlap with the gap');
  console.log(`PASS ${branchCount} branches x ${cluesPerBranch} clues: root ${(metrics.rootOffsetRatio * 100).toFixed(2)}% off-center, branch spread ${(metrics.branchSpread * 100).toFixed(2)}%, clues outside ${metrics.clueOutsideBranch}, crossings ${metrics.treeCrossings}, overlaps ${metrics.overlapCount}`);
}

const first = layout(hubCards, hubEdges), second = layout(hubCards, hubEdges);
assert.deepEqual(first, second);
for (const node of hubCards) {
  if (!node.fixed) continue;
  assert.deepEqual(first[node.id], {x: node.x, y: node.y});
}
const nodes = new Map(hubCards.map(value => [value.id, value]));
for (let i = 0; i < hubCards.length; i++) for (let j = i + 1; j < hubCards.length; j++) {
  const a = hubCards[i], b = hubCards[j];
  assert.equal(overlaps(a.id, b.id, first, nodes), false, `${a.id}/${b.id} overlap`);
}
for (const edge of hubEdges) {
  const a = first[edge.from], b = first[edge.to];
  const distance = Math.hypot((a.x + 100) - (b.x + 100), (a.y + 70) - (b.y + 70));
  assert.ok(distance >= edgeMin - 1 && distance <= edgeMax + 1, `${edge.from}/${edge.to}: ${distance}`);
}
const center = first.center, centroid = hubCards.reduce((sum, value) => ({
  x: sum.x + first[value.id].x + value.width / 2,
  y: sum.y + first[value.id].y + value.height / 2,
}), {x: 0, y: 0});
centroid.x /= hubCards.length; centroid.y /= hubCards.length;
assert.ok(Math.hypot(center.x + 100 - centroid.x, center.y + 70 - centroid.y) < 40);

const many = Array.from({length: 200}, (_, i) => ({...card('card-' + String(i).padStart(3, '0')), fixed: i === 0, x: i * 220, y: 0}));
const manyEdges = many.slice(1).map((value, i) => ({from: many[i].id, to: value.id}));
const started = performance.now();
layout(many, manyEdges);
const elapsed = performance.now() - started;
assert.ok(elapsed < 200, `200-card layout took ${elapsed.toFixed(1)}ms`);
console.log(`PASS deterministic 40-card layout has fixed cards, gap-free rectangles, bounded edges, and a centered hub`);
console.log(`PASS 200-card layout completes in ${elapsed.toFixed(1)}ms`);
