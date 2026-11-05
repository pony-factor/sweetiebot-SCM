// Preserve native attachment records rather than reconstructing thumbnails.
var scmToolkitComposerAttachmentFields = [
    'attachmentOrder', 'imageAttachments', 'imageCommentDrafts', 'appshotContexts',
    'fileAttachments', 'pastedTextAttachments', 'uploadedFileAttachments', 'addedFiles',
    'mcpAppModelContextAttachments', 'selectedTextAttachments', 'responseTextAnnotations'
];
var scmToolkitComposerAttachmentDrafts;
function scmToolkitRestoreComposerAttachments(scope, signal, scopeKey) {
    return scope.get(signal)?.[scopeKey(scope.value)];
}
function scmToolkitSaveComposerAttachments(scope, state, signal, scopeKey) {
    const key = scopeKey(scope.value);
    const records = {};
    for (const field of scmToolkitComposerAttachmentFields) {
        if (Array.isArray(state[field])) records[field] = state[field];
    }
    const drafts = { ...(scope.get(signal) || {}) };
    if (Object.values(records).some(items => items.length)) drafts[key] = records;
    else delete drafts[key];
    scope.set(signal, drafts);
}
