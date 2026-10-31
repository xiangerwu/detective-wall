(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WallLayout = api;
})(typeof self === 'object' ? self : this, function () {
  const constants = Object.freeze({
    gap: 24,
    iterations: 18,
    collisionPasses: 48,
    edgeMin: 220,
    edgeRest: 320,
    // A 39-spoke ring of 200px cards still fits below this practical ceiling.
    edgeMax: 2000,
    minWedge: 0.08,
    wedgeTolerance: 0.04,
    maxStep: 20,
  });

  function number(value, fallback) {
    return Number.isFinite(value) ? Number(value) : fallback;
  }

  function hash(value) {
    let result = 2166136261;
    for (let i = 0; i < value.length; i++) {
      result ^= value.charCodeAt(i);
      result = Math.imul(result, 16777619);
    }
    return result >>> 0;
  }

  function direction(value) {
    return (hash(value) / 0x100000000) * Math.PI * 2;
  }

  // The server has no DOM; this keeps its collision box close to the browser card.
  function estimateHeight(card) {
    const title = String(card && card.title || '');
    const note = String(card && card.note || '');
    const titleLines = Math.max(1, Math.ceil(title.length / 24));
    const noteLines = note ? note.split(/\r?\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 42)), 0) : 0;
    return Math.min(360, Math.max(96, 52 + titleLines * 22 + noteLines * 18 + (note ? 8 : 0)));
  }

  function centerOf(node, position) {
    return {x: position.x + node.width / 2, y: position.y + node.height / 2};
  }

  function distanceBetween(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function edgeDistance(a, b, positions, byId) {
    const ca = centerOf(byId.get(a), positions.get(a));
    const cb = centerOf(byId.get(b), positions.get(b));
    return distanceBetween(ca, cb);
  }

  function separate(a, b, pa, pb, movableA, movableB) {
    const dx = pb.x + b.width / 2 - pa.x - a.width / 2;
    const dy = pb.y + b.height / 2 - pa.y - a.height / 2;
    // Keep a 1px numerical cushion so rounded server coordinates still leave
    // the requested 24px browser gap after layout is applied.
    const limitX = (a.width + b.width) / 2 + constants.gap + 1;
    const limitY = (a.height + b.height) / 2 + constants.gap + 1;
    const overlapX = limitX - Math.abs(dx);
    const overlapY = limitY - Math.abs(dy);
    if (overlapX <= 0 || overlapY <= 0 || (!movableA && !movableB)) return false;
    // A vertical tie keeps a single new card beside its fixed anchor instead of
    // needlessly moving it farther along the row.
    const horizontal = overlapX < overlapY;
    const amount = horizontal ? overlapX : overlapY;
    let sign = horizontal ? Math.sign(dx) : Math.sign(dy);
    if (!sign) {
      if (horizontal) sign = hash(a.id + '\0' + b.id + 'x') % 2 ? 1 : -1;
      else if (movableA && !movableB) sign = -1;
      else if (!movableA && movableB) sign = 1;
      else sign = hash(a.id + '\0' + b.id + 'y') % 2 ? 1 : -1;
    }
    if (horizontal) {
      if (movableA && movableB) { pa.x -= sign * amount / 2; pb.x += sign * amount / 2; }
      else if (movableA) pa.x -= sign * amount;
      else if (movableB) pb.x += sign * amount;
    } else if (movableA && movableB) { pa.y -= sign * amount / 2; pb.y += sign * amount / 2; }
    else if (movableA) pa.y -= sign * amount;
    else if (movableB) pb.y += sign * amount;
    return true;
  }

  function clampToWedge(node, point, origin, wedge) {
    if (!wedge) return false;
    const center = centerOf(node, point);
    const dx = center.x - origin.x, dy = center.y - origin.y;
    const radius = Math.hypot(dx, dy);
    if (!radius) return false;
    const middle = (wedge.start + wedge.end) / 2;
    let angle = Math.atan2(dy, dx);
    while (angle < middle - Math.PI) angle += Math.PI * 2;
    while (angle > middle + Math.PI) angle -= Math.PI * 2;
    const limited = Math.max(wedge.start - constants.wedgeTolerance,
      Math.min(wedge.end + constants.wedgeTolerance, angle));
    if (Math.abs(limited - angle) < 1e-9) return false;
    point.x = origin.x + Math.cos(limited) * radius - node.width / 2;
    point.y = origin.y + Math.sin(limited) * radius - node.height / 2;
    return true;
  }

  function layoutCards(inputCards, inputEdges) {
    const rawCards = Array.isArray(inputCards) ? inputCards : [];
    const nodes = rawCards.filter(card => card && typeof card.id === 'string').map(card => ({
      id: card.id,
      width: Math.max(1, number(card.width, 200)),
      height: Math.max(1, number(card.height, 140)),
      fixed: !!card.fixed,
      x: number(card.x, 0),
      y: number(card.y, 0),
      source: card,
    })).sort((a, b) => a.id.localeCompare(b.id));
    const byId = new Map(nodes.map(node => [node.id, node]));
    const edges = [];
    const seenEdges = new Set();
    for (const edge of Array.isArray(inputEdges) ? inputEdges : []) {
      if (!edge || !byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to) continue;
      const key = [edge.from, edge.to].sort().join('\0');
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({from: edge.from, to: edge.to, key});
    }
    edges.sort((a, b) => a.key.localeCompare(b.key));
    const adjacency = new Map(nodes.map(node => [node.id, []]));
    const degree = new Map(nodes.map(node => [node.id, 0]));
    for (const edge of edges) {
      adjacency.get(edge.from).push(edge.to);
      adjacency.get(edge.to).push(edge.from);
      degree.set(edge.from, degree.get(edge.from) + 1);
      degree.set(edge.to, degree.get(edge.to) + 1);
    }
    for (const values of adjacency.values()) values.sort();

    const positions = new Map(nodes.map(node => [node.id, {x: node.x, y: node.y}]));
    const targets = new Map();
    const wedges = new Map();
    const targetRadii = new Map();
    const treeEdges = new Set();
    const origins = new Map();
    const rootById = new Map();
    const components = [];
    const visited = new Set();
    for (const node of nodes) {
      if (visited.has(node.id)) continue;
      const component = [], queue = [node.id];
      visited.add(node.id);
      while (queue.length) {
        const id = queue.shift();
        component.push(id);
        for (const next of adjacency.get(id)) if (!visited.has(next)) { visited.add(next); queue.push(next); }
      }
      component.sort();
      components.push(component);
    }
    const fixedNodes = nodes.filter(node => node.fixed);
    const fixedBounds = fixedNodes.length ? {
      left: Math.min(...fixedNodes.map(node => node.x)),
      top: Math.min(...fixedNodes.map(node => node.y)),
      right: Math.max(...fixedNodes.map(node => node.x + node.width)),
      bottom: Math.max(...fixedNodes.map(node => node.y + node.height)),
    } : null;
    let freeComponent = 0;

    for (const component of components) {
      const centerId = component.reduce((best, id) => {
        if (!best) return id;
        const degreeDelta = degree.get(id) - degree.get(best);
        return degreeDelta > 0 || degreeDelta === 0 && id > best ? id : best;
      }, null);
      for (const id of component) rootById.set(id, centerId);
      const fixed = component.filter(id => byId.get(id).fixed);
      let origin;
      if (byId.get(centerId).fixed) {
        origin = centerOf(byId.get(centerId), positions.get(centerId));
      } else if (fixed.length) {
        const points = fixed.map(id => centerOf(byId.get(id), positions.get(id)));
        origin = {x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
          y: points.reduce((sum, point) => sum + point.y, 0) / points.length};
        const anchor = fixed.map(id => byId.get(id));
        const radius = Math.max(constants.edgeRest,
          (byId.get(centerId).width + Math.max(...anchor.map(node => node.width))) / 2
            + constants.gap * 2);
        const angle = fixed.length === 1 ? Math.PI / 4 : direction(component.join('\0'));
        origin = {x: origin.x + Math.cos(angle) * radius, y: origin.y + Math.sin(angle) * radius};
      } else if (fixedBounds) {
        const column = freeComponent % 3, row = Math.floor(freeComponent / 3);
        origin = {x: fixedBounds.right + 360 + column * 760, y: fixedBounds.top + 180 + row * 480};
        freeComponent++;
      } else {
        const column = freeComponent % 3, row = Math.floor(freeComponent / 3);
        origin = {x: 220 + column * 760, y: 220 + row * 480};
        freeComponent++;
      }
      origins.set(centerId, origin);
      const parent = new Map([[centerId, null]]), depth = new Map([[centerId, 0]]);
      const queue = [centerId];
      for (let index = 0; index < queue.length; index++) {
        const id = queue[index];
        for (const next of adjacency.get(id)) if (!parent.has(next)) {
          parent.set(next, id);
          depth.set(next, depth.get(id) + 1);
          queue.push(next);
          treeEdges.add([id, next].sort().join('\0'));
        }
      }
      const children = new Map();
      for (const id of component) if (parent.has(id)) {
        const parentId = parent.get(id);
        if (!children.has(parentId)) children.set(parentId, []);
        children.get(parentId).push(id);
      }
      for (const values of children.values()) values.sort();
      const leafCount = new Map();
      const byDepth = new Map();
      for (const id of component) {
        const value = depth.get(id);
        if (!byDepth.has(value)) byDepth.set(value, []);
        byDepth.get(value).push(id);
      }
      const deepestFirst = [...component].sort((a, b) => depth.get(b) - depth.get(a) || a.localeCompare(b));
      for (const id of deepestFirst) {
        const values = children.get(id) || [];
        leafCount.set(id, values.length ? values.reduce((sum, child) => sum + leafCount.get(child), 0) : 1);
      }
      // A single new card connected to a fixed card keeps the legacy right-side
      // placement; free components retain an id-derived orientation.
      const orientation = byId.get(centerId).fixed ? -Math.PI : direction(component.join('\0'));
      wedges.set(centerId, {start: orientation, end: orientation + Math.PI * 2});
      const wedgeQueue = [centerId];
      for (let index = 0; index < wedgeQueue.length; index++) {
        const id = wedgeQueue[index], parentWedge = wedges.get(id), values = children.get(id) || [];
        if (!values.length) continue;
        const span = parentWedge.end - parentWedge.start;
        const minimum = Math.min(constants.minWedge, span / values.length);
        const remaining = Math.max(0, span - minimum * values.length);
        const totalLeaves = values.reduce((sum, child) => sum + leafCount.get(child), 0);
        let cursor = parentWedge.start;
        for (const child of values) {
          const childSpan = minimum + remaining * leafCount.get(child) / totalLeaves;
          wedges.set(child, {start: cursor, end: cursor + childSpan});
          cursor += childSpan;
          wedgeQueue.push(child);
        }
      }
      const radii = [0];
      for (let level = 1; level <= Math.max(...depth.values()); level++) {
        const levelNodes = byDepth.get(level);
        const previousNodes = byDepth.get(level - 1);
        const maxWidth = Math.max(...levelNodes.map(id => byId.get(id).width));
        const maxHeight = Math.max(...levelNodes.map(id => byId.get(id).height));
        const radialStep = Math.hypot(maxWidth + constants.gap, maxHeight + constants.gap);
        let arcRadius = 0;
        if (levelNodes.length > 1) {
          const clearance = Math.hypot(maxWidth + constants.gap, maxHeight + constants.gap);
          const narrowest = Math.min(...levelNodes.map(id => wedges.get(id).end - wedges.get(id).start));
          const chord = 2 * Math.sin(Math.min(Math.PI / 2, narrowest / 2));
          arcRadius = clearance / Math.max(0.01, chord);
        }
        radii[level] = Math.max(radii[level - 1] + radialStep, arcRadius);
        if (previousNodes.length === 1 && levelNodes.length === 1) {
          radii[level] = Math.max(radii[level], radii[level - 1] + radialStep);
        }
      }
      const center = byId.get(centerId);
      if (!center.fixed) {
        const point = {x: origin.x - center.width / 2, y: origin.y - center.height / 2};
        positions.set(centerId, point);
        targets.set(centerId, point);
      } else {
        origins.set(centerId, centerOf(center, positions.get(centerId)));
      }
      const componentOrigin = origins.get(centerId);
      for (const id of component) {
        const node = byId.get(id);
        if (id === centerId || node.fixed) continue;
        const wedge = wedges.get(id), radius = radii[depth.get(id)], angle = (wedge.start + wedge.end) / 2;
        const point = {x: componentOrigin.x + Math.cos(angle) * radius - node.width / 2,
          y: componentOrigin.y + Math.sin(angle) * radius - node.height / 2};
        positions.set(id, point);
        targets.set(id, {x: point.x, y: point.y});
        targetRadii.set(id, radius);
      }
      targetRadii.set(centerId, 0);
      for (const id of component) {
        if (byId.get(id).fixed) targets.set(id, positions.get(id));
        if (id !== centerId) targetRadii.set(id, radii[depth.get(id)]);
      }
    }

    const edgeTargets = new Map();
    for (const edge of edges) if (treeEdges.has(edge.key)) {
      const aRadius = targetRadii.get(edge.from) || 0, bRadius = targetRadii.get(edge.to) || 0;
      edgeTargets.set(edge.key, Math.max(constants.edgeMin,
        Math.min(constants.edgeMax, Math.abs(bRadius - aRadius) || constants.edgeRest)));
    }
    const anchors = new Set(components.map(component => component.reduce((best, id) => {
      if (!best) return id;
      const degreeDelta = degree.get(id) - degree.get(best);
      return degreeDelta > 0 || degreeDelta === 0 && id > best ? id : best;
    }, null)));
    const movable = node => !node.fixed && !anchors.has(node.id);
    const velocity = new Map(nodes.map(node => [node.id, {x: 0, y: 0}]));
    for (let iteration = 0; iteration < constants.iterations; iteration++) {
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        separate(a, b, positions.get(a.id), positions.get(b.id), movable(a), movable(b));
      }
      const force = new Map(nodes.map(node => [node.id, {x: 0, y: 0}]));
      for (const edge of edges) if (treeEdges.has(edge.key)) {
        const a = byId.get(edge.from), b = byId.get(edge.to), pa = positions.get(a.id), pb = positions.get(b.id);
        const ca = centerOf(a, pa), cb = centerOf(b, pb);
        let dx = cb.x - ca.x, dy = cb.y - ca.y, length = Math.hypot(dx, dy);
        if (!length) { const angle = direction(edge.key); dx = Math.cos(angle); dy = Math.sin(angle); length = 1; }
        const desired = edgeTargets.get(edge.key) || constants.edgeRest;
        const pull = Math.max(-10, Math.min(16, (length - desired) * 0.018));
        const fx = dx / length * pull, fy = dy / length * pull;
        if (movable(a)) { force.get(a.id).x += fx; force.get(a.id).y += fy; }
        if (movable(b)) { force.get(b.id).x -= fx; force.get(b.id).y -= fy; }
      }
      for (const node of nodes) if (movable(node)) {
        const point = positions.get(node.id), target = targets.get(node.id), value = force.get(node.id), speed = velocity.get(node.id);
        value.x += (target.x - point.x) * 0.02;
        value.y += (target.y - point.y) * 0.02;
        speed.x = (speed.x + value.x) * 0.78;
        speed.y = (speed.y + value.y) * 0.78;
        speed.x = Math.max(-constants.maxStep, Math.min(constants.maxStep, speed.x));
        speed.y = Math.max(-constants.maxStep, Math.min(constants.maxStep, speed.y));
        point.x += speed.x;
        point.y += speed.y;
        clampToWedge(node, point, origins.get(rootById.get(node.id)), wedges.get(node.id));
      }
    }

    // A bounded number of direct passes makes the rectangle+gap invariant hold
    // even when a dense graph exhausts the force iterations.
    for (let pass = 0; pass < constants.collisionPasses; pass++) {
      let moved = false;
      for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        if (separate(a, b, positions.get(a.id), positions.get(b.id), movable(a), movable(b))) moved = true;
      }
      for (const node of nodes) if (movable(node)) {
        clampToWedge(node, positions.get(node.id), origins.get(rootById.get(node.id)), wedges.get(node.id));
      }
      if (!moved) break;
    }
    for (const node of nodes) {
      const point = positions.get(node.id);
      if (node.fixed) { point.x = node.x; point.y = node.y; }
      else {
        point.x = Math.round(point.x * 1000) / 1000;
        point.y = Math.round(point.y * 1000) / 1000;
      }
    }
    return Object.fromEntries(nodes.map(node => [node.id, positions.get(node.id)]));
  }

  function api(cards, edges, options) {
    return layoutCards(cards, edges, options);
  }
  api.layout = layoutCards;
  api.layoutCards = layoutCards;
  api.estimateHeight = estimateHeight;
  api.constants = constants;
  api.edgeDistance = edgeDistance;
  return api;
});
