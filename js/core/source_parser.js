/**
 * SourceParser — the wiki-source ↔ entity-object bridge used by the editor.
 *
 * The important change from the old version: whether a line is a relation or a
 * plain property is decided by the **predicate registry**, not by a second,
 * browser-only relation table. `任职：【组织】|部长|2001年|2005年` is therefore parsed
 * as the `memberOf` primitive with role and date qualifiers, and `儿子：【…】`
 * as `maleChild`, so gender-aware search keeps working on edited records.
 */
(function (global) {
  'use strict';

  function SourceParser(predicates) {
    if (!(this instanceof SourceParser)) return new SourceParser(predicates);
    this.P = predicates || global.HMPredicates;
  }

  /** Parse `【id1】，【id2】 | role | start | end` lists into relation rows. */
  SourceParser.prototype.parseBracketValues = function (value) {
    if (!value) return [];
    var P = this.P;
    var out = [];
    var parts = String(value).split(/[，,、](?=\s*【)/);
    for (var i = 0; i < parts.length; i++) {
      var trimmed = parts[i].trim();
      var m = trimmed.match(/^【(.+?)】(.*)$/);
      if (!m) continue;
      // Strip an explicit type hint: 【id|type】 -> id.
      var id = m[1];
      var pipeIdx = id.lastIndexOf('|');
      if (pipeIdx !== -1) id = id.substring(0, pipeIdx);
      var rest = m[2].trim();
      var row = null;
      if (rest) {
        var segs = rest.replace(/^\|\s*/, '').split('|').map(function (s) { return s.trim(); });
        var hasQualifier = segs.some(Boolean);
        if (hasQualifier) {
          row = {};
          if (segs[0]) row.role = segs[0];
          if (segs[1]) row.start = segs[1];
          if (segs[2]) row.end = segs[2];
          row.target = id;
          // Keep the bare-id form when nothing meaningful was provided.
          if (!row.role && !row.start && !row.end) row = null;
        }
      }
      out.push(row || id);
    }
    return out;
  };

  /** Is this line's key a registered relation word? */
  SourceParser.prototype.isRelationKey = function (key) {
    if (!key) return false;
    var parts = this.P.splitModifiers(key);
    var base = this.P.PREDICATES[parts.base] ? parts.base : this.P.resolve(parts.base);
    return !!base;
  };

  /**
   * Parse wiki-style source text into an entity object.
   * Recognised prefixes: 名称/别名/标签/wiki/源, everything else is a property
   * unless its key resolves to a predicate, in which case it becomes a relation.
   */
  SourceParser.prototype.parse = function (source, type, existing) {
    var entity = {
      id: (existing && existing.id) || null,
      type: type,
      name: '',
      aliases: [],
      props: {},
      relations: {},
      sources: [],
    };
    var P = this.P;
    var lines = String(source || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#') continue;
      var idx = line.search(/[:：]/);
      if (idx <= 0) continue;
      var key = line.slice(0, idx).trim();
      var value = line.slice(idx + 1).trim();
      if (!value) continue;

      if (key === '名称') { entity.name = value; continue; }
      if (key === '别名') {
        entity.aliases = value.split(/[，,、]/).map(function (s) { return s.trim(); }).filter(Boolean);
        continue;
      }
      if (key === '标签') {
        // `标签` is retired along with the `tags` field: it mixed classification
        // words with bare entity ids in one unvalidated array. `时代` is retired
        // too — era is derived from birthDate/deathDate at query time, so a source
        // file that says `时代：西漢` should write the dates instead.
        continue;
      }
      if (key === 'wiki') { entity.wikiUrl = value; continue; }
      if (key === '源') {
        var segs = value.split('|').map(function (s) { return s.trim(); });
        entity.sources.push({ name: segs[0] || '', date: segs[1] || '', note: segs[segs.length - 1] || '' });
        continue;
      }

      if (this.isRelationKey(key) && value.indexOf('【') >= 0) {
        entity.relations[key] = this.parseBracketValues(value);
      } else {
        entity.props[key] = value;
      }
    }

    if (!entity.id && entity.name) entity.id = entity.name;
    return entity;
  };

  /** Serialise an entity back to source text (round-trips through parse). */
  SourceParser.prototype.stringify = function (entity) {
    var P = this.P;
    var lines = ['名称：' + (entity.name || '')];
    if (entity.aliases && entity.aliases.length) lines.push('别名：' + entity.aliases.join('，'));
    Object.keys(entity.props || {}).forEach(function (k) {
      if (entity.props[k]) lines.push(k + '：' + entity.props[k]);
    });
    Object.keys(entity.relations || {}).forEach(function (relKey) {
      var rows = entity.relations[relKey];
      if (!rows || !rows.length) return;
      var def = P.def(relKey);
      var qualified = def && (def.qualifiers || []).indexOf('role') >= 0;
      var text = rows.map(function (r) {
        var id = typeof r === 'string' ? r : r.target;
        if (!qualified) return '【' + id + '】';
        var extra = [r.role || '', r.start || '', r.end || ''].filter(Boolean).join(' | ');
        return '【' + id + '】' + (extra ? ' | ' + extra : '');
      });
      lines.push(relKey + '：' + text.join('，'));
    });
    if (entity.wikiUrl) lines.push('wiki：' + entity.wikiUrl);
    (entity.sources || []).forEach(function (src) {
      // A migrated corpus stores evidence ids here, not objects. Reading
      // src.name off a string produced bare "源：" lines that round-trip back
      // into the parser as empty citations.
      if (typeof src === 'string') {
        lines.push('源：【' + src + '】');
        return;
      }
      var parts = [src.name || '', src.date || '', src.note || ''].filter(Boolean);
      lines.push('源：' + parts.join(' | '));
    });
    return lines.join('\n');
  };

  global.HMSource = { SourceParser: SourceParser };
})(typeof window !== 'undefined' ? window : globalThis);
