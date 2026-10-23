/**
 * Relation direction for graph rendering.
 *
 * The old implementation hard-coded a 100+ entry word -> direction table, which
 * duplicated (and drifted from) the relation vocabulary. Direction is derivable:
 *
 *   spouse / sibling / kin / colleague / friend  -> mutual (inverse === key)
 *   everything else                              -> the arrow points from the
 *                                                   subject to the object, and
 *                                                   the focus's own rows are
 *                                                   'from-focus'
 *
 * `directional(word)` returns one of 'mutual' | 'to-focus' | 'from-focus'.
 */
(function (global) {
  'use strict';

  function Direction(P) {
    if (!(this instanceof Direction)) return new Direction(P);
    this.P = P || global.HMPredicates;
  }

  /**
   * Direction of a stored relation, from the focus node's point of view.
   *
   * `focusIsSubject` = the focus entity is the *subject* of the row, i.e. the
   * row reads "(focus, father, other)" -> "focus is other's father", so the
   * arrow leaves the focus ('from-focus'). When the focus is the object, the
   * arrow points at it ('to-focus'). A stored '/inverse' key flips the reading.
   */
  Direction.prototype.directional = function (word, focusIsSubject) {
    var P = this.P;
    var parts = P.splitModifiers(word);
    var canonical = P.PREDICATES[parts.base] ? parts.base : P.resolve(parts.base);
    if (!canonical) return 'mutual';

    var def = P.PREDICATES[canonical];
    if (def.symmetric || def.inverse === def.key) return 'mutual';
    // A negated edge has no direction to show; render it without an arrowhead.
    if (P.isNegated(word)) return 'mutual';

    // Stored orientation and row orientation both matter: an '/inverse' key
    // says "the object is the subject of the base relation".
    var subjectIsFocus = !!focusIsSubject !== P.isInversed(word);
    return subjectIsFocus ? 'from-focus' : 'to-focus';
  };

  /** Arrow markers to use for a direction. */
  Direction.prototype.markers = function (direction) {
    if (direction === 'mutual') return ['arrow-start', 'arrow-end'];
    if (direction === 'to-focus') return ['arrow-end'];
    return ['arrow-start'];
  };

  global.HMDirection = { RelationDirection: Direction };
})(typeof window !== 'undefined' ? window : globalThis);
