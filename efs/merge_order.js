'use strict';

// Readiness is refreshed before every round. Lane direction is only a tie-break;
// dependencies always precede their children and local checks still gate merges.
function orderMergeCandidates(prs) {
  const position = new Map(prs.map((pr, index) => [pr.number, index]));
  const descendants = pr => {
    const seen = new Set([pr.head]);
    let count = 0, changed = true;
    while (changed) {
      changed = false;
      for (const child of prs) if (seen.has(child.base) && !seen.has(child.head)) {
        seen.add(child.head); count++; changed = true;
      }
    }
    return count;
  };
  const readiness = pr => pr.waitingFor?.length ? 4
    : pr.checkFailures || ['blocked', 'unstable'].includes(pr.mergeableState) ? 3
    : pr.mergeable === false || pr.mergeableState === 'dirty' ? 2
    : pr.mergeable === true ? 0 : 1;
  const compare = (a, b) => readiness(a) - readiness(b)
    || (a.attempts || 0) - (b.attempts || 0)
    || descendants(b) - descendants(a)
    || (a.changeSize ?? Infinity) - (b.changeSize ?? Infinity)
    || position.get(a.number) - position.get(b.number);
  const pending = [...prs], ordered = [];
  while (pending.length) {
    const eligible = pending.filter(pr => !pending.some(parent => parent !== pr && parent.head === pr.base));
    // Keep cycles visible for diagnosis; validation refuses their handoffs.
    if (!eligible.length) { ordered.push(...pending); break; }
    const next = eligible.sort(compare)[0];
    ordered.push(next);
    pending.splice(pending.indexOf(next), 1);
  }
  return ordered;
}

module.exports = { orderMergeCandidates };
