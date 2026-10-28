'use strict';
// A web proposal never overrides attribution, original commit content, or the
// user's exact PR title. The local canonical formatter supplies any corrections.
function validateCommitProposal(proposal, prepared) {
  if (!proposal) return { ...prepared, proposed: false, adjusted: false };
  if (proposal.title !== prepared.title) throw Error('Proposed commit title must exactly match the selected PR title and number.');
  const message = proposal.message.replace(/\r\n?/g, '\n').trimEnd();
  const canonical = prepared.message.replace(/\r\n?/g, '\n').trimEnd();
  return { ...prepared, message: message === canonical ? message : canonical, proposed: true, adjusted: message !== canonical };
}
module.exports = { validateCommitProposal };
