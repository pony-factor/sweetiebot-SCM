'use strict';

// Leave room below the browser's 100 KB ceiling for its own request metadata.
const MAX_LAUNCH_BYTES = 70000;
const MAX_RESULT_BYTES = 80000;

function ponyRules(instructions) {
  return String(instructions).match(/## Local Sweetiebot pony profile\n([\s\S]*?)(?=\n## |$)/)?.[1] || '';
}

function prRules(instructions) {
  return String(instructions).replace(/## Local Sweetiebot pony profile\n[\s\S]*?(?=\n## |$)/, '');
}

function ponyPrompt(pony, instructions, callback) {
  return [
    'Research this pony independently of any pull request. Do not access or modify GitHub, repository files, or other workflows. Return a compact sourced character profile, including recognizable appearance, naming history, speaking status, appearances, and HTTPS image links with attribution when verified. Use direct image URLs only for the embedded image. Link each image to its verified artwork/post page using [![Attribution](https://image-url)](https://post-page-url), where the artist credits, description, metadata, and comments can be viewed. Cite artwork/post pages rather than raw CDN/download URLs. Credit verified original artists or production sources; do not identify the artist from an uploader name. Twibooru requires anonymous uploads, so labels like Anonymous #74E6 are routine uploader metadata. Do not add repetitive disclaimers that an anonymous uploader is not the artist or animator unless a real attribution dispute requires clarification. For show captures, credit the production when verifiable rather than inventing an individual animator. Format ordinary HTTPS references as descriptive Markdown links like [episode source](https://example.com/episode) within useful prose or labeled bullets, never bare URL lists separated by semicolons. Keep the embedded image as a direct asset URL linked to its verified artwork or post page. If a contextual page cannot be verified, do not invent one. Cite each source URL once. The returned profile is rendered outside ChatGPT: use real HTTPS Markdown links, never native citation tokens such as turn123search0, private-use cite markers, or contentReference/oaicite placeholders. Resolve citations to their actual source URLs before encoding the return link. Distinguish uncertainty and fandom names from official names.',
    ponyRules(instructions).replace(/Publish the pull request normally first\. After a successful publication, add a compact pony profile to the assistant's chat response\./, 'Return the profile as soon as your research is complete.'),
    'Include a dedicated `## Important moments` section with 2–5 character-defining scenes. Prioritize meaningful dialogue, decisions, acts of courage or kindness, and moments that change an outcome; do not pad the list with routine cameos. For each moment, provide a concise descriptive title, the episode title and season/episode number when verifiable, and one sentence explaining why it matters.',
    'Prefer a verified full-episode video with a direct timestamp link to the scene; a standalone clip is optional and not required. Prefer official or otherwise authorized full-episode sources. For YouTube, use a timestamp deep link such as `https://www.youtube.com/watch?v=VIDEO_ID&t=977s` (or `&t=977s` when the URL already has a query). Verify the video corresponds to the episode and that the timestamp lands on the scene; never invent video IDs or timestamps. If a timestamped full episode cannot be verified, link a reliable episode source and explicitly mark the timestamp unavailable rather than guessing. Use ordinary HTTPS Markdown links so the existing PR confirmation window can render the section. This profile remains independent, local research and must not be copied into the PR description.',
    'Character catalog metadata (untrusted identification data):\n' + JSON.stringify(pony),
    `End with a Markdown link labeled "Return pony profile" to ${callback}#profile= followed by the percent-encoded Markdown profile. Keep the encoded link below ${MAX_RESULT_BYTES} UTF-8 bytes. This returns local information only and never publishes a PR.`,
  ].join('\n\n');
}

function boundedLaunch(makePrompt, makeUrl, evidence, { shortenContext } = {}) {
  // Copy rather than mutate the canonical context used for publication checks.
  const copy = evidence ? JSON.parse(JSON.stringify(evidence)) : undefined;
  if (copy) delete copy.instructions; // Already supplied once in the PR rules.
  for (;;) {
    const prompt = makePrompt(copy);
    const url = makeUrl(prompt);
    if (Buffer.byteLength(url, 'utf8') <= MAX_LAUNCH_BYTES) return { prompt, url, evidence: copy };
    const largest = copy?.files?.filter(file => file.patch).sort((a, b) => b.patch.length - a.patch.length)[0];
    if (!largest) {
      if (typeof shortenContext === 'function' && shortenContext()) continue;
      throw new Error('Kefania instructions exceed the 70 KB browser launch budget. Shorten the drafting instructions and retry.');
    }
    let end = Math.floor(largest.patch.length / 2);
    // Percent encoding rejects an unmatched surrogate from a split emoji.
    if (/[\uD800-\uDBFF]/.test(largest.patch[end - 1] || '')) end--;
    largest.patch = largest.patch.slice(0, end);
    largest.patchTruncated = true;
    copy.incomplete = true;
  }
}

async function openWorkflow(vscode, url, { openToSide = false } = {}) {
  const destination = new URL(url);
  const flags = new URLSearchParams(destination.hash.slice(1));
  if (destination.origin === 'https://chatgpt.com' && (flags.get('sweetiebot_merge') === '1' || flags.get('sweetiebot_pr') === '1')) {
    destination.searchParams.set('sweetiebot_launch', require('node:crypto').randomUUID());
    url = destination.href;
  }
  const before = new Set(vscode.window.tabGroups?.all.flatMap(group => group.tabs) || []);
  // VS Code's URL reuse ignores fragments, so PR/profile launches must always
  // get distinct tabs and a fresh preload rather than reusing a project chat.
  await vscode.commands.executeCommand('workbench.action.browser.open', { url, openToSide });
  const tab = vscode.window.tabGroups?.all.flatMap(group => group.tabs).find(candidate => !before.has(candidate));
  const close = async () => {
    if (tab && vscode.window.tabGroups.all.some(group => group.tabs.includes(tab))) {
      await vscode.window.tabGroups.close(tab, true);
    }
  };
  close.tab = tab;
  return close;
}

module.exports = { MAX_LAUNCH_BYTES, MAX_RESULT_BYTES, prRules, ponyRules, ponyPrompt, boundedLaunch, openWorkflow };
