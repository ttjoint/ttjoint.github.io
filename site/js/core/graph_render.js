/**
 * Graph rendering — D3 force-directed ego network around a focus entity.
 *
 * Plain browser module (no Vue). Loaded after predicates/direction/data_store so
 * `window.HMGraph.renderGraph` is available when the detail view mounts.
 */
(function (global) {
  'use strict';

/**
 * D3 force-directed ego graph.
 *
 * Extracted from app.js so the renderer is a pure function of (container, data,
 * layout) and takes its dependencies explicitly instead of reaching for globals.
 */
function renderGraph(container, focusId, focusType, onNodeClick, deps) {
  const DataStore = deps.DataStore;
  const RelationDirection = deps.RelationDirection;
  const d3 = deps.d3 || window.d3;
  const svg = d3.select(container).html('').append('svg');
  const width = container.clientWidth;
  const height = 500;
  svg.attr('viewBox', [0, 0, width, height]);

  // 箭头标记（硬编码颜色，避免 CSS 变量在 marker 中无法解析）
  // markerUnits="userSpaceOnUse" 确保箭头尺寸不受 stroke-width 缩放影响
  svg.append('defs').html(`
    <marker id="arrow-end" viewBox="0 -6 12 12" refX="10" refY="0"
            markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto">
      <polygon points="0 -5, 10 0, 0 5" fill="#64748b"/>
    </marker>
    <marker id="arrow-start" viewBox="0 -6 12 12" refX="2" refY="0"
            markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto">
      <polygon points="12 -5, 2 0, 12 5" fill="#64748b"/>
    </marker>
  `);

  const g = svg.append('g');
  const rn = DataStore.resolveName.bind(DataStore);

  const nodes = [];
  const links = [];
  const nodeIds = new Set();

  function addNode(id, type, label, group) {
    if (nodeIds.has(id) || !id) return;
    nodeIds.add(id);
    nodes.push({ id, type, label, group });
  }

  addNode(focusId, focusType, rn(focusId), 'focus');

  const entity = DataStore.getEntity(focusId);
  if (!entity) return;

  // 组颜色映射
  const groupMap = {
    '父母': 'parent', '子女': 'child', '配偶': 'spouse', '兄弟姐妹': 'sibling', '亲属': 'relative',
    '所属组织': 'org', '成员': 'member', '上级组织': 'parent', '下级组织': 'sub',
    '参战方': 'participant', '参战事件': 'event', '参与人物': 'person', '参与事件': 'event',
    '前置事件': 'prev', '后续事件': 'next', '关键地点': 'location', '关键事件': 'event',
    '师生': 'academic', '同僚': 'colleague', '朋友': 'friend', '门客': 'retainer',
    '政敌': 'rival', '学术': 'academic', '文学': 'literary', '同乡': 'hometown',
    '荐举': 'recommend', '其他': 'other'
  };

  // 1. 处理注册的关系
  const relations = entity.relations || {};
  for (const [relKey, relData] of Object.entries(relations)) {
    if (!relData || relData.length === 0) continue;
    const relDef = RelationRegistry[relKey];
    const group = relDef ? (groupMap[relKey] || relDef.targetType) : 'prop-rel';
    const targetType = relDef ? relDef.targetType : 'person';
    const direction = RelationDirection[relKey] || 'mutual';

    for (const r of relData) {
      const targetId = typeof r === 'string' ? r : r.target;
      if (!targetId) continue;
      addNode(targetId, targetType, rn(targetId), group);
      const roleLabel = (typeof r !== 'string' && r.role) ? ' (' + r.role + ')' : '';
      let source, target;
      if (direction === 'to-focus') {
        source = targetId; target = focusId;
      } else {
        source = focusId; target = targetId;
      }
      links.push({ source, target, label: relKey + roleLabel, direction, linkKey: relKey });
    }
  }

  // 2. 自动扫描 props 中【】指向人物的引用
  if (entity.props) {
    for (const [propKey, propValue] of Object.entries(entity.props)) {
      if (!propValue || typeof propValue !== 'string') continue;
      const ref = DataStore.resolveRef(propValue);
      if (!ref || ref.id === focusId) continue;
      // 人物引用人物 → 自动加入人物-人物关系图谱
      if (focusType === 'person' && ref.type === 'person') {
        const direction = RelationDirection[propKey] || 'mutual';
        addNode(ref.id, 'person', rn(ref.id), 'prop-rel');
        let source, target;
        if (direction === 'to-focus') {
          source = ref.id; target = focusId;
        } else {
          source = focusId; target = ref.id;
        }
        links.push({ source, target, label: propKey, direction, linkKey: 'prop:' + propKey });
      }
      // 非人物引用 → 仍加入图谱但用默认双向
      else if (focusType !== 'person' || ref.type !== 'person') {
        addNode(ref.id, ref.type, rn(ref.id), 'prop-rel');
        links.push({ source: focusId, target: ref.id, label: propKey, direction: 'mutual', linkKey: 'prop:' + propKey });
      }
    }
  }

  if (nodes.length === 1) {
    g.append('text')
      .attr('x', width / 2).attr('y', height / 2)
      .attr('text-anchor', 'middle')
      .attr('fill', 'var(--color-text-muted)')
      .text('暂无关系数据');
    return;
  }

  // 计算同节点对之间的多重边序号
  const pairCount = {};
  links.forEach(l => {
    const key = [l.source, l.target].sort().join('||');
    pairCount[key] = (pairCount[key] || 0) + 1;
  });
  const pairIndex = {};
  links.forEach(l => {
    const key = [l.source, l.target].sort().join('||');
    if (!pairIndex[key]) pairIndex[key] = 0;
    l._pairTotal = pairCount[key];
    l._pairIdx = pairIndex[key]++;
  });

  const colorMap = {
    focus: 'var(--color-primary)',
    parent: '#f59e0b', child: '#10b981', spouse: '#ec4899',
    sibling: '#06b6d4', relative: '#8b5cf6',
    member: 'var(--color-primary)', org: 'var(--color-accent)',
    sub: 'var(--color-accent)',
    participant: '#f59e0b', 'prop-rel': '#6b7280',
    prev: '#06b6d4', next: '#10b981', location: '#8b5cf6',
    academic: '#7c3aed', colleague: '#0891b2', friend: '#059669',
    retainer: '#d97706', rival: '#dc2626', literary: '#db2777',
    hometown: '#4f46e5', recommend: '#65a30d', other: '#9ca3af'
  };

  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(100))
    .force('charge', d3.forceManyBody().strength(-300))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide(40));

  // 用 path 替代 line 以支持弧形多重边
  const linkG = g.append('g').selectAll('g')
    .data(links).join('g');

  // 主连线路径：marker-end 始终指向 target，mutual 额外加 marker-start 指向 source
  const linkPath = linkG.append('path')
    .attr('fill', 'none')
    .attr('stroke', '#94a3b8')
    .attr('stroke-width', 1.8)
    .attr('opacity', 0.75)
    .attr('marker-end', 'url(#arrow-end)')
    .attr('marker-start', d => d.direction === 'mutual' ? 'url(#arrow-start)' : null);

  const linkLabel = linkG.append('text')
    .attr('font-size', '9px')
    .attr('fill', 'var(--color-text-muted)')
    .attr('text-anchor', 'middle')
    .attr('dy', -4)
    .text(d => d.label);

  const node = g.append('g').selectAll('g')
    .data(nodes).join('g')
    .style('cursor', 'pointer')
    .on('click', (event, d) => {
      if (d.id !== focusId) onNodeClick(d.id, d.type);
    });

  // 在节点数据上记录半径，供连线计算端点偏移
  node.each(function(d) { d._r = d.group === 'focus' ? 18 : 14; });

  node.append('circle')
    .attr('r', d => d._r)
    .attr('fill', d => colorMap[d.group] || 'var(--color-primary)')
    .attr('stroke', '#fff')
    .attr('stroke-width', 2);

  node.append('text')
    .attr('text-anchor', 'middle')
    .attr('dy', 28)
    .attr('font-size', '10px')
    .attr('fill', 'var(--color-text)')
    .attr('font-weight', d => d.group === 'focus' ? '700' : '400')
    .text(d => d.label.length > 5 ? d.label.slice(0, 5) + '…' : d.label);

  // 计算弧形路径（弧线偏移量）
  const ARC_GAP = 28;  // 多重边之间的弧线间距

  function arcPath(d) {
    const sx = d.source.x, sy = d.source.y;
    const tx = d.target.x, ty = d.target.y;
    const dx = tx - sx, dy = ty - sy;
    const dr = Math.sqrt(dx * dx + dy * dy);
    if (dr === 0) return '';
    // 在圆边缘处截断，避免箭头被圆点挡住
    const sr = d.source._r || 14;
    const tr = d.target._r || 14;
    const sx2 = sx + dx / dr * sr;
    const sy2 = sy + dy / dr * sr;
    const tx2 = tx - dx / dr * tr;
    const ty2 = ty - dy / dr * tr;
    if (d._pairTotal <= 1) return `M${sx2},${sy2}L${tx2},${ty2}`;
    // 多重边：弯曲弧度
    const offset = (d._pairIdx - (d._pairTotal - 1) / 2) * ARC_GAP;
    const mx = (sx + tx) / 2 - dy / dr * offset;
    const my = (sy + ty) / 2 + dx / dr * offset;
    return `M${sx2},${sy2}Q${mx},${my} ${tx2},${ty2}`;
  }

  simulation.on('tick', () => {
    linkPath.attr('d', arcPath);
    linkLabel.attr('x', d => {
      const sx = d.source.x, sy = d.source.y;
      const tx = d.target.x, ty = d.target.y;
      const dx = tx - sx, dy = ty - sy;
      const dr = Math.sqrt(dx * dx + dy * dy);
      if (d._pairTotal <= 1) return (sx + tx) / 2;
      const offset = (d._pairIdx - (d._pairTotal - 1) / 2) * ARC_GAP;
      return (sx + tx) / 2 - dy / dr * offset;
    })
    .attr('y', d => {
      const sx = d.source.x, sy = d.source.y;
      const tx = d.target.x, ty = d.target.y;
      const dx = tx - sx, dy = ty - sy;
      const dr = Math.sqrt(dx * dx + dy * dy);
      if (d._pairTotal <= 1) return (sy + ty) / 2 - 6;
      const offset = (d._pairIdx - (d._pairTotal - 1) / 2) * ARC_GAP;
      return (sy + ty) / 2 + dx / dr * offset - 6;
    });
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  const zoom = d3.zoom().scaleExtent([0.5, 4]).on('zoom', (event) => {
    g.attr('transform', event.transform);
  });
  svg.call(zoom);
}

  global.HMGraph = { renderGraph: renderGraph };
})(typeof window !== 'undefined' ? window : globalThis);
